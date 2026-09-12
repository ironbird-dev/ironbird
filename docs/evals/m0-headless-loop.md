# M0 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| A coding agent, given only the output of `ironbird commands`, completes cart → payment → receipt headlessly | met | Transcript below: 12 CLI commands, completed unaided, no repository access |
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

Runner: a fresh general-purpose coding agent (Claude Sonnet) given only the CLI invocation and the prompt below; it confirmed it read no repository files or docs. Daemon started separately with `ironbird serve` in `examples/checkout`.

Prompt given verbatim:

> You have a CLI called `ironbird`. Run `ironbird commands` to learn what an app can do, then complete a purchase: add item `cut-45`, pay by card, and stop when `order.status` is `completed` with a non-zero total. Use only the `ironbird` CLI. Time is manual: when a result says `quiescent: true`, advance the clock by `nextTimerInMs`.

Result: completed unaided. Final `ironbird state order`:

```json
{"target":"headless","rev":6,"path":"order","value":{"status":"completed","totalCents":4500,"paymentSucceeded":true,"orderId":"ord_1"}}
```

Commands run, in order (outputs trimmed to the relevant fields):

1. `ironbird --help`, then `ironbird commands` → three commands with JSON Schemas (`cart.addItem`, `cart.clear`, `payment.start`).
2. `ironbird send --help`, `state --help`, `wait --help`, `clock --help`.
3. `ironbird status` → one headless target, `appId com.example.checkout`, `rev 0`.
4. `ironbird state order` → `{"status":"none","totalCents":0,"paymentSucceeded":false}`; `ironbird state cart` → empty cart.
5. `ironbird send cart.addItem '{"sku":"cut-45","qty":1}'` → `rev 1`, cart subtotal 4500, `settle: { idle: true }`.
6. `ironbird clock now` → `1767225600000`; `ironbird settle` → idle.
7. `ironbird send payment.start '{"method":"card"}'` → `payment.status collecting`, events `payment_started`, `reader.collectPayment`; `settle: { idle: false, quiescent: true, pending: [reader.collectPayment (fake)], nextTimerInMs: 1200 }`.
8. `ironbird clock advance 1200` → `payment.status submitting`, token `fake_4500`, events `collected`, `api.submitPayment`; `settle: { quiescent: true, pending: [api.submitPayment (fake)], nextTimerInMs: 300 }`.
9. `ironbird clock advance 300` → `payment.status awaitingServerEcho`, `paymentId pay_1`; `settle: { idle: true, quiescent: false, pending: [], nextTimerInMs: 500 }`.
10. `ironbird fakes` → `{}`; `ironbird settle` → same idle result with `nextTimerInMs: 500`.
11. `ironbird clock advance 500` → events `order.confirmed` (total 4500), `payment.succeeded`, `order_completed`; order `completed`, `rev 6`.
12. `ironbird state order` → completed with `totalCents 4500`.

## Follow-ups

What the agent found confusing (recorded as follow-ups, not blockers):

- After step 9 the result said `idle: true, quiescent: false` while still reporting `nextTimerInMs: 500`. The pending server echo is a manual-clock timer, which the tracker does not count as a pending effect, so the step is idle by the tracker's definition even though nothing will progress without a clock advance. The agent inferred that a present `nextTimerInMs` means "advance the clock" and proceeded. Follow-up: consider reporting `quiescent: true` (or a dedicated field) when the manual clock has a scheduled timer and no effects are pending, and document the rule in docs/architecture.md §6.5 and docs/cli.md.
- `ironbird fakes` printed `{}` with no explanation; fakes with controls arrive in M2.
