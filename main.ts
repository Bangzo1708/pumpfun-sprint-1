// Pump.fun Paper Sprint entry: a filtered launch sniper with one pyramid add.
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts
// and the protocol shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for
// byte in vendor/. See strategy.ts for the idea and the numbers behind it.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Diagnostics go to stderr only: stdout carries the replies, and anything
// written there would corrupt the action log. Nothing here reads the clock,
// the environment or Math.random, so the two graded executions stay
// byte-identical.
await runBot({
  ...createStrategy(DEFAULT_PARAMS),
  onDone(state) {
    const sol = (n: bigint) => (Number(n) / 1e9).toFixed(6);
    console.error(
      `done: cash ${sol(BigInt(state.account.cash_lamports))} SOL, ` +
        `open positions ${state.positions.size}, curves seen ${state.curves.size}`,
    );
  },
});
