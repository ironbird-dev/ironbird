# M0 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| A coding agent, given only the output of `ironbird commands`, completes cart → payment → receipt headlessly | pending | Transcript below |
| ironbird overhead per headless command < 5 ms p95; CLI invocation < 300 ms p95 | met | `pnpm bench --check`: headless dispatch with pending fake effect p95 0.12 ms (< 5 ms), CLI invocation end to end p95 129.57 ms (< 300 ms). Full table below |
| A `react-native` import in the headless graph produces `HEADLESS_LOAD_FAILED` with the import chain | met | `packages/cli/src/cli/commands/serve.test.ts`, "exits 2 with HEADLESS_LOAD_FAILED and the import chain when the entry imports react-native": expects `importChain` to equal `['headless.ts', 'pricing.ts', 'react-native']`. `packages/cli/src/bundle.test.ts` covers the same failure at the loader level with `importChain: ['entry.ts', 'pricing.ts', 'react-native']` |

## Benchmark

Machine: Apple M3 Pro, macOS 27.0, Node v26.8.1.

```
measurement                                  p50 ms   p95 ms   budget
headless dispatch, no pending effect (floor)   0.01     0.01   5 ok
headless dispatch with pending fake effect     0.08     0.12   5 ok
headless dispatch over HTTP                    1.64     2.27   n/a
CLI invocation end to end                    104.60   129.57   300 ok
```

The first two rows both run in process against the same headless target, but exercise different paths through settle: the floor row dispatches `cart.clear`, a pure reducer step with no pending fake effect, so `whenIdle` returns on its first check; the realistic row dispatches `payment.start`, which leaves the fake reader's `collectPayment` pending on the manual clock and goes through the quiescent branch (three macrotask yields before `quiescent: true`), which is the path most real commands take and what the < 5 ms p95 budget is measured against. Both are comfortably under budget, as is the CLI invocation row (end-to-end `node bin.js state cart`, under the 300 ms p95 budget); the HTTP row has no budget and is reported for reference.

## Agent transcript

Start `ironbird serve` in `examples/checkout`, open a fresh coding-agent session with no repository context, and give it exactly this prompt:

> You have a CLI called `ironbird`. Run `ironbird commands` to learn what an app can do, then complete a purchase: add item `cut-45`, pay by card, and stop when `order.status` is `completed` with a non-zero total. Use only the `ironbird` CLI. Time is manual: when a result says `quiescent: true`, advance the clock by `nextTimerInMs`.

Paste the session's commands and the final `ironbird state order` output. Then break `src/core/pricing.ts` in a scratch copy by importing `react-native`, run `ironbird serve`, and paste the `HEADLESS_LOAD_FAILED` output with its `importChain`.

**Status: pending.** The controller runs this session separately and fills in this section with the transcript and result.
