// Filtered launch sniper with a single pyramid add — pump.fun paper trading.
//
// Idea: most pump.fun launches are rugs that die within minutes, but the ones
// that open organically — the creator put real SOL in and has not sold, a
// handful of distinct wallets bought in the first slots, no one has sold yet,
// price not already run away — run often enough to pay. We buy those in their
// first slots, small (0.1 SOL, capped at 1% of the curve's real SOL), add once
// more only if the price steps up 20% (winners get size, losers stay small),
// and exit on +50% take profit, a -20% stop, a 15% trailing stop once up 30%,
// a 300-slot time limit, or the moment the creator sells.
//
// Why these numbers (chosen on the kit's 24h dev window, preferring flat
// regions over point optima):
// - A tight stop does not work here: dumps happen in single trades, so a
//   -8% stop still realises -40% and only locks in losses on coins that
//   recover. A -20% stop with a +50% take profit and 300 slots to run is
//   where the backtest turns positive.
// - The 1%-of-reserve cap forces small buys on young curves, so we require
//   at least 1.5 SOL of real reserves and a creator buy of at least 0.1 SOL:
//   that filter alone lifts the win rate from ~19% to ~21% and the net PnL
//   from about breakeven to +0.18 SOL on the dev window.
// - One add at +20% (not two, not at +50%) roughly doubles the dev-window
//   net PnL: the rare runners carry the position.
//
// Guardrails: every buy is at least 0.01 SOL, the bot trades ~30 coins per
// 6h slice of the dev window (min 22 observed), and max drawdown on the dev
// window is ~2% (limit 50%).
//
// Pure function of the batches the harness sends: no clock, no randomness,
// no I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin on the first buy. */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buys in the create slot: SOL window. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most. */
  maxBuyers: number;
  /** Price now over the create price, at most. */
  maxRunup: number;
  /** Exit when the position is worth this much over its cost (fraction). */
  tp: number;
  /** Exit when it is worth this much under its cost (fraction). */
  sl: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trail: number;
  trailArm: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Buys after the first one, each on a later batch, while the price keeps stepping up. */
  maxAdds: number;
  /** An add needs the price at least this far above the previous buy's decision price. */
  addStep: number;
  /** SOL per add. */
  addSol: number;
  /** Most SOL per position in total (first buy + adds). */
  maxStakeSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.1,
  minBuySol: 0.01,
  minRqSol: 1.5,
  maxRqSol: 30,
  minDevBuySol: 0.1,
  maxDevBuySol: 2,
  minTrades: 3,
  minBuyers: 2,
  maxBuyers: 8,
  maxRunup: 1.5,
  tp: 0.5,
  sl: 0.2,
  trail: 0.15,
  trailArm: 0.3,
  maxHold: 300,
  buySlipBps: 10_000,
  maxAdds: 1,
  addStep: 0.2,
  addSol: 0.1,
  maxStakeSol: 0.2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Coin {
  creator: Pubkey;
  createSlot: number;
  vq0: number;
  vt0: number;
  devBuy: number;
  trades: number;
  buyers: Set<Pubkey>;
  soldByOthers: number;
  devSold: boolean;
  done: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  exiting: boolean;
  invested: number;
  adds: number;
  lastBuyPrice: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const orders: OrderInput[] = [];
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

      // Read this batch's events into the per-coin launch tape.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            creator: e.creator,
            createSlot: e.slot,
            vq0: Number(e.virtual_quote_reserves),
            vt0: Number(e.virtual_token_reserves),
            devBuy: 0,
            trades: 0,
            buyers: new Set(),
            soldByOthers: 0,
            devSold: false,
            done: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades++;
          if (e.is_buy) {
            if (e.user === c.creator && e.slot === c.createSlot) c.devBuy += sol;
            else if (e.user !== c.creator) c.buyers.add(e.user);
          } else if (e.user === c.creator) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.done = true;
        }
      }

      // What selling a position would pay now, curve fees and one tx fee deducted.
      const valueOf = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        if (pos === undefined) return 0;
        const curve = state.curves.get(mint);
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve?.virtual_quote_reserves ?? 0);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve?.virtual_token_reserves ?? 1);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      let free = Number(state.freeCashLamports()) / LAMPORTS;

      // Exits first, then at most one pyramid add per held winner.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) held.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const value = valueOf(mint);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        const c = coins.get(mint);
        let exit = h.exiting;
        if (!exit && cost > 0 && value >= cost * (1 + p.tp)) exit = true;
        if (!exit && cost > 0 && value <= cost * (1 - p.sl)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened >= p.maxHold) exit = true;
        if (!exit && c !== undefined && c.devSold) exit = true;
        if (!exit) {
          // Pyramid into strength only: price stepped up from the last buy.
          if (p.maxAdds > 0 && h.adds < p.maxAdds && h.invested < p.maxStakeSol && !pendingMints.has(mint)) {
            const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
            if (price >= h.lastBuyPrice * (1 + p.addStep)) {
              const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
              let amount = Math.min(p.addSol, p.maxStakeSol - h.invested, capSol);
              if (amount > free - tx) amount = free - tx;
              if (amount >= p.minBuySol && orders.length < cap) {
                orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
                free -= amount + tx;
                h.invested += amount;
                h.adds++;
                h.lastBuyPrice = price;
              }
            }
          }
          continue;
        }
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        const cc = coins.get(mint);
        if (cc !== undefined) cc.done = true;
      }

      // Entries: launches from the last few slots, in event order.
      let open = state.committedPositionCount();
      for (const e of batch.events) {
        if (orders.length >= cap) break;
        if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
        const mint = e.mint;
        const c = coins.get(mint);
        if (c === undefined || c.done) continue;
        if (state.positions.has(mint) || pendingMints.has(mint) || held.has(mint)) continue;
        const age = now - c.createSlot;
        if (age < p.minAge || age > p.maxAge) {
          if (age > p.maxAge) c.done = true;
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // Rug filter: real reserves, creator skin in the game, organic buyers, no sells yet.
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        if (c.devBuy < p.minDevBuySol || c.devBuy > p.maxDevBuySol) continue;
        if (c.devSold || c.soldByOthers > 0) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        const runup = (Number(curve.virtual_quote_reserves) * c.vt0) / (Number(curve.virtual_token_reserves) * c.vq0);
        if (runup > p.maxRunup || runup < 0.5) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(p.stakeSol, capSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        held.set(mint, { opened: now, peakValue: 0, exiting: false, invested: amount, adds: 0, lastBuyPrice: price });
        open++;
      }
      return orders;
    },
  };
}
