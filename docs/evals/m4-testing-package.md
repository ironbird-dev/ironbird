# M4 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| With the planted scenario removed, model-based testing finds the race within 1,000 runs for at least 9 of 10 seeds | met (10/10) | `examples/checkout/test/model.gate.test.ts`, run by `pnpm gate:m4` (2026-10-04): 10/10 seeds found the race with `PLANT_RACE=1`, after 22 to 458 runs (median 111.5); the same configuration without `PLANT_RACE` found nothing in 10 × 1,000 runs. No scenario file is involved. Per-seed results are identical on Node 26.10.0 and 22.14.0. CI re-checks the five-step witness and seed 1 on every commit in `examples/checkout/test/model.smoke.test.ts` (below) |
| Mutation score ≥ 70% on the clock and tracker | met (96.56%) | `pnpm mutation` on 2026-10-04, twice, with the same detected-versus-survived outcome for all 349 mutants (Killed and Timeout counted as detected): clock.ts 97.16%, tracker.ts 96.15%, from a baseline of 73.93% (details below) |

## Race gate (2026-10-04)

### Configuration

`modelTest` from `@ironbird/testing` against the example's headless definition, configured in `examples/checkout/test/race-model.ts` as in the M4 design §6.4, with the step weights unchanged:

```ts
steps: [
  { command: 'cart.addItem', payload: [{ sku: 'cut-45', qty: 1 }, { sku: 'beard-20', qty: 2 }] },
  { command: 'payment.start', payload: [{ method: 'saved' }, { method: 'card' }] },
  { fake: 'api', control: 'setEcho', payload: [{ mode: 'manual' }, { mode: 'auto' }] },
  { fake: 'api', control: 'emit', payload: [{ event: 'payment.succeeded' }, { event: 'order.confirmed' }, { event: 'payment.failed' }] },
  { clock: { maxMs: 1000 } },
],
invariants: { 'completed orders have a non-zero total': (s) => !(s.order.status === 'completed' && s.order.totalCents === 0) },
maxSteps: 20, numRuns: 1000, seeds 1 to 10
```

Each run is 1 to 20 steps drawn from the five, equally weighted, applied to a freshly reset target (manual clock, fresh fakes), with the invariant checked after every step. Planted runs pass `env: { PLANT_RACE: '1' }`. Control runs pass `env: {}` while the test process itself has `PLANT_RACE=1` set, so the control also shows the flag cannot leak in. The race needs a clock advance between the saved payment and the success event, because the submission resolves only after 300 ms; the M4 design §6.4 lists the two witnesses.

Machine: Apple M3 Pro, macOS 27.2. fast-check 4.9.0, Vitest 5.0.0.

### Planted (`PLANT_RACE=1`)

| Seed | Found | Runs to failure | Shrunk steps | Wall time, Node 26 | Wall time, Node 22 |
|---|---|---|---|---|---|
| 1 | yes | 22 | 4 | 37 ms | 171 ms |
| 2 | yes | 167 | 5 | 33 ms | 137 ms |
| 3 | yes | 90 | 4 | 17 ms | 46 ms |
| 4 | yes | 98 | 4 | 33 ms | 52 ms |
| 5 | yes | 458 | 4 | 61 ms | 85 ms |
| 6 | yes | 212 | 4 | 33 ms | 41 ms |
| 7 | yes | 125 | 4 | 28 ms | 34 ms |
| 8 | yes | 67 | 4 | 20 ms | 22 ms |
| 9 | yes | 216 | 4 | 33 ms | 44 ms |
| 10 | yes | 46 | 4 | 12 ms | 15 ms |
| **All** | **10/10** | | | **307 ms** | **647 ms** |

"Runs to failure" is `details.runs` from the `INVARIANT_FAILED` error, which `modelTest` takes from fast-check's `RunDetails.numRuns`: the runs made until the property failed, the failing run included, shrinking excluded. A seed that found nothing reports 1,000 and has no shrunk steps. Wall time covers the whole `modelTest` call, shrinking and the replay that names the invariant included.

### Control (no `PLANT_RACE`)

| Seed | Found | Runs | Steps applied | Steps rejected | Wall time, Node 26 | Wall time, Node 22 |
|---|---|---|---|---|---|---|
| 1 | no | 1000 | 4,411 | 1,832 | 111 ms | 148 ms |
| 2 | no | 1000 | 4,381 | 1,776 | 109 ms | 134 ms |
| 3 | no | 1000 | 4,329 | 1,840 | 104 ms | 924 ms |
| 4 | no | 1000 | 4,301 | 1,849 | 105 ms | 667 ms |
| 5 | no | 1000 | 4,219 | 1,875 | 109 ms | 138 ms |
| 6 | no | 1000 | 4,447 | 1,844 | 111 ms | 128 ms |
| 7 | no | 1000 | 4,592 | 1,900 | 359 ms | 136 ms |
| 8 | no | 1000 | 4,454 | 1,847 | 188 ms | 156 ms |
| 9 | no | 1000 | 4,285 | 1,819 | 105 ms | 891 ms |
| 10 | no | 1000 | 4,275 | 1,845 | 102 ms | 726 ms |
| **All** | **0/10** | **10,000** | 43,694 | 18,427 | **1403 ms** | **4048 ms** |

The control finding nothing is what makes the planted result mean something: the invariant is not trivially false. Unplanted, an order completes only after an `order.confirmed` that carries the submitted subtotal, which is never 0. Rejected steps are actions invalid in the current state, such as adding to a locked cart or emitting with no submission; `modelTest` records them and continues (M4 design D5).

### Wall time

`time pnpm gate:m4`, which builds first: 11.2 s on Node 26.10.0 and 13.1 s on Node 22.14.0, of which Vitest itself reported 1.98 s and 5.36 s. Of the Vitest time, planted 307 ms and control 1403 ms on Node 26; planted 647 ms and control 4048 ms on Node 22. The M4 design expected minutes of model runs; the gate takes seconds, because each run drives a manual clock and in-process fakes with no real waiting. Both runs were made with the 1-minute load average near 22 (another job was running on the machine), so the Node 22 control times, which jump from about 130 ms to 700 to 920 ms on four seeds, are likely load noise; a quiet machine would only be faster.

### Result file

`examples/checkout/.ironbird/gate/m4-race-gate.node26.json` from the run above. The Node 22 file has the same per-seed `found`, `runs`, `path`, `steps`, and control step counts, checked field by field; only `measuredAt`, `node`, and the `wallMs` fields differ. The `trace` paths below are as the run wrote them.

```json
{
  "measuredAt": "2026-10-04T06:08:57.578Z",
  "node": "v26.10.0",
  "machine": "Apple M3 Pro, darwin 27.2.0",
  "config": {
    "numRuns": 1000,
    "maxSteps": 20,
    "seeds": [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10
    ],
    "invariant": "completed orders have a non-zero total",
    "steps": [
      {
        "command": "cart.addItem",
        "payload": [
          {
            "sku": "cut-45",
            "qty": 1
          },
          {
            "sku": "beard-20",
            "qty": 2
          }
        ]
      },
      {
        "command": "payment.start",
        "payload": [
          {
            "method": "saved"
          },
          {
            "method": "card"
          }
        ]
      },
      {
        "fake": "api",
        "control": "setEcho",
        "payload": [
          {
            "mode": "manual"
          },
          {
            "mode": "auto"
          }
        ]
      },
      {
        "fake": "api",
        "control": "emit",
        "payload": [
          {
            "event": "payment.succeeded"
          },
          {
            "event": "order.confirmed"
          },
          {
            "event": "payment.failed"
          }
        ]
      },
      {
        "clock": {
          "maxMs": 1000
        }
      }
    ]
  },
  "planted": {
    "found": 10,
    "of": 10,
    "required": 9,
    "wallMs": 307,
    "seeds": [
      {
        "seed": 1,
        "found": true,
        "runs": 22,
        "wallMs": 37,
        "invariant": "completed orders have a non-zero total",
        "path": "21:3:1:6:9:8:12:8:8:11:10:9:8",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 300,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-1/2026-10-04T06-08-55-893Z-completed-orders-have-a-non-zero-total.trace.yaml"
      },
      {
        "seed": 2,
        "found": true,
        "runs": 167,
        "wallMs": 33,
        "invariant": "completed orders have a non-zero total",
        "path": "166:4:4:3:9:7:7",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 103,
            "rejected": false
          },
          {
            "clock": 197,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-2/2026-10-04T06-08-55-929Z-completed-orders-have-a-non-zero-total.trace.yaml"
      },
      {
        "seed": 3,
        "found": true,
        "runs": 90,
        "wallMs": 17,
        "invariant": "completed orders have a non-zero total",
        "path": "89:1:2:6:8:6:7:11",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 300,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-3/2026-10-04T06-08-55-946Z-completed-orders-have-a-non-zero-total.trace.yaml"
      },
      {
        "seed": 4,
        "found": true,
        "runs": 98,
        "wallMs": 33,
        "invariant": "completed orders have a non-zero total",
        "path": "97:2:1:9:10:11:10:9:9:9:12:12:8",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 300,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-4/2026-10-04T06-08-55-980Z-completed-orders-have-a-non-zero-total.trace.yaml"
      },
      {
        "seed": 5,
        "found": true,
        "runs": 458,
        "wallMs": 61,
        "invariant": "completed orders have a non-zero total",
        "path": "457:9:7:9:7:10:8:9:8",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 300,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-5/2026-10-04T06-08-56-041Z-completed-orders-have-a-non-zero-total.trace.yaml"
      },
      {
        "seed": 6,
        "found": true,
        "runs": 212,
        "wallMs": 33,
        "invariant": "completed orders have a non-zero total",
        "path": "211:2:1:3:3:6:5:4:6",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 300,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-6/2026-10-04T06-08-56-074Z-completed-orders-have-a-non-zero-total.trace.yaml"
      },
      {
        "seed": 7,
        "found": true,
        "runs": 125,
        "wallMs": 28,
        "invariant": "completed orders have a non-zero total",
        "path": "124:2:0:1:5:9:10:8:10:10:10:8",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 300,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-7/2026-10-04T06-08-56-102Z-completed-orders-have-a-non-zero-total.trace.yaml"
      },
      {
        "seed": 8,
        "found": true,
        "runs": 67,
        "wallMs": 20,
        "invariant": "completed orders have a non-zero total",
        "path": "66:4:5:8:7:6:8:6:6:6:6:6:6:6:6:8",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 300,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-8/2026-10-04T06-08-56-122Z-completed-orders-have-a-non-zero-total.trace.yaml"
      },
      {
        "seed": 9,
        "found": true,
        "runs": 216,
        "wallMs": 33,
        "invariant": "completed orders have a non-zero total",
        "path": "215:3:3:9:10:9:8:9:8:11:8",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 300,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-9/2026-10-04T06-08-56-156Z-completed-orders-have-a-non-zero-total.trace.yaml"
      },
      {
        "seed": 10,
        "found": true,
        "runs": 46,
        "wallMs": 12,
        "invariant": "completed orders have a non-zero total",
        "path": "45:2:1:6:6:5:6:5:5:5",
        "steps": [
          {
            "send": "cart.addItem",
            "payload": {
              "sku": "cut-45",
              "qty": 1
            },
            "rejected": false
          },
          {
            "send": "payment.start",
            "payload": {
              "method": "saved"
            },
            "rejected": false
          },
          {
            "clock": 300,
            "rejected": false
          },
          {
            "fake": "api",
            "control": "emit",
            "payload": {
              "event": "payment.succeeded"
            },
            "rejected": false
          }
        ],
        "trace": "/Users/sunkibaek/apps/ironbird/examples/checkout/.ironbird/gate/traces/seed-10/2026-10-04T06-08-56-169Z-completed-orders-have-a-non-zero-total.trace.yaml"
      }
    ]
  },
  "control": {
    "found": 0,
    "of": 10,
    "wallMs": 1403,
    "seeds": [
      {
        "seed": 1,
        "found": false,
        "runs": 1000,
        "wallMs": 111,
        "stepsApplied": 4411,
        "stepsRejected": 1832
      },
      {
        "seed": 2,
        "found": false,
        "runs": 1000,
        "wallMs": 109,
        "stepsApplied": 4381,
        "stepsRejected": 1776
      },
      {
        "seed": 3,
        "found": false,
        "runs": 1000,
        "wallMs": 104,
        "stepsApplied": 4329,
        "stepsRejected": 1840
      },
      {
        "seed": 4,
        "found": false,
        "runs": 1000,
        "wallMs": 105,
        "stepsApplied": 4301,
        "stepsRejected": 1849
      },
      {
        "seed": 5,
        "found": false,
        "runs": 1000,
        "wallMs": 109,
        "stepsApplied": 4219,
        "stepsRejected": 1875
      },
      {
        "seed": 6,
        "found": false,
        "runs": 1000,
        "wallMs": 111,
        "stepsApplied": 4447,
        "stepsRejected": 1844
      },
      {
        "seed": 7,
        "found": false,
        "runs": 1000,
        "wallMs": 359,
        "stepsApplied": 4592,
        "stepsRejected": 1900
      },
      {
        "seed": 8,
        "found": false,
        "runs": 1000,
        "wallMs": 188,
        "stepsApplied": 4454,
        "stepsRejected": 1847
      },
      {
        "seed": 9,
        "found": false,
        "runs": 1000,
        "wallMs": 105,
        "stepsApplied": 4285,
        "stepsRejected": 1819
      },
      {
        "seed": 10,
        "found": false,
        "runs": 1000,
        "wallMs": 102,
        "stepsApplied": 4275,
        "stepsRejected": 1845
      }
    ]
  },
  "smoke": {
    "seed": 1,
    "runs": 22,
    "steps": [
      {
        "send": "cart.addItem",
        "payload": {
          "sku": "cut-45",
          "qty": 1
        },
        "rejected": false
      },
      {
        "send": "payment.start",
        "payload": {
          "method": "saved"
        },
        "rejected": false
      },
      {
        "clock": 300,
        "rejected": false
      },
      {
        "fake": "api",
        "control": "emit",
        "payload": {
          "event": "payment.succeeded"
        },
        "rejected": false
      }
    ],
    "wallMs": 37
  }
}
```

### The CI smoke

`examples/checkout/test/model.smoke.test.ts` runs in `pnpm test` (the `serial` project), so in CI on Node 22 and 26:

- The reliable five-step witness through `createTestTarget`: manual echo, add `cut-45`, start a saved payment, advance 300 ms, emit `payment.succeeded`. With `PLANT_RACE=1` the order is `completed` with total 0 and the invariant fails. Without it, and with `PLANT_RACE=1` set in the shell, the order is still waiting for `order.confirmed` and the invariant holds; the confirmation then completes it at 4,500.
- A step list with a misspelled control fails with `UNKNOWN_CONTROL` before any run, so a broken configuration can never count as finding the race.
- `modelTest` with seed 1 and `numRuns: 1000`, the planted seed with the fewest runs to failure (22): it must find the race again (`INVARIANT_FAILED` naming the race invariant), and the trace it writes must reproduce `completed` with total 0 when replayed through the CLI's scenario runner on a fresh planted target, and must not violate the invariant on a clean one. Its test took 40 ms on Node 26 and 550 ms on Node 22.

The run count and the shrunk steps are deliberately not pinned, so a fast-check upgrade that changes them does not fail CI. If the seed stops finding the race, re-run `pnpm gate:m4` and re-pin the seed from the result file's `smoke` entry.

### A counterexample trace

The trace seed 1 wrote under `.ironbird/gate/traces/seed-1/`:

```yaml
name: "Counterexample: completed orders have a non-zero total"
description: "modelTest seed 1, path 21:3:1:6:9:8:12:8:8:11:10:9:8. A trace: it reproduces the violating state; add expect steps to make it a regression check."
steps:
  - reset: true
  - send: cart.addItem
    payload:
      sku: cut-45
      qty: 1
  - send: payment.start
    payload:
      method: saved
  - clock: 300
  - fake: api
    control: emit
    payload:
      event: payment.succeeded
```

It is a trace, not a regression scenario: it has no `expect`, so `ironbird scenario run` passes it and leaves the app in the violating state. Adding `- expect: order.totalCents` with `notEquals: 0` as the last step turns it into a check that fails planted and passes clean.

### Step weights

Not used: the uniform configuration met the criterion.

## Mutation score

StrykerJS 10.0.0 with the command runner, Vitest 5.0.0, Node 26.10.0, on an Apple M3 Pro (11 cores) with macOS 27.2, at commit 993852e. `stryker.config.json` mutates `packages/core/src/clock.ts` and `packages/core/src/tracker.ts` and runs the 13 core test files collected by `packages/core/vitest.stryker.config.ts` (`call-log`, `clock`, `conditions`, `errors`, `fake`, `headless`, `paths`, `protocol`, `recorder`, `registry`, `serialize`, `target`, `tracker`). Thresholds: high 85, low 70, break 70. The score is Stryker's: (killed + timed out) / (killed + timed out + survived + no coverage). Equivalent mutants stay in it; nothing is disabled.

| Run | clock.ts | tracker.ts | Total | Killed | Timeout | Survived | No coverage | Duration |
|---|---|---|---|---|---|---|---|---|
| Baseline (before the plan's tests) | 65.96% | 79.33% | 73.93% | 233 | 25 | 91 | 0 | 4 min 9 s |
| Final, run 1 | 97.16% | 96.15% | 96.56% | 278 | 59 | 12 | 0 | 4 min 54 s |
| Final, run 2 | 97.16% | 96.15% | 96.56% | 278 | 59 | 12 | 0 | 4 min 47 s |

Both final runs started from scratch (no incremental file) with the 1-minute load average below 8. Runs are compared mutant by mutant, keyed by file, start and end location, mutator, and replacement, with Killed and Timeout both counted as detected. The end location is part of the key because five mutants share their start position, mutator, and replacement with another mutant; a key without it silently drops them (344 instead of 349 compared). The two final runs: `compared 349 mutants, 0 differ`. The same 12 mutants survive in both, and each is listed below. The two runs were made before this branch was rebased onto `m4-testing-package`; the rebase changed no file under test and no test of the clock or tracker (only one line of `errors.ts` and its test). A third run at 993852e gave the same scores and `compared 349 mutants, 0 differ` against run 1.

**Runner.** The Stryker Vitest runner 10.0.0 fails on Vitest 5.0.0: in mutant runs it selects no tests (`testsCompleted` is 0 for 331 of the 349 mutants), raises no error, and reports every covered mutant as survived, for a score of 0.00%. On the same mutants and tests, the command runner's baseline detected 258 of the 349. So Stryker runs `pnpm exec vitest run -c packages/core/vitest.stryker.config.ts` through its command runner, with coverage analysis off and concurrency 4. **Departure from the design:** D8 and spec §7 name the Vitest runner; the command runner runs the same tests, with the same mutants and score definition, but slower (every mutant runs all 13 files) and without per-test coverage. `@stryker-mutator/vitest-runner` stays a root dev dependency so the runner can be retried on a later release. Two consequences of the command runner: `stryker run --incremental` reuses every result even after the tests change, because the runner reports one test with no file information (use `pnpm mutation`, or `--incremental --force`); and Stryker's timeout is 1.5 × the dry run's time + 5 s per mutant, so heavy machine load can turn a survivor into a Timeout. Measure at low load.

**Timeouts.** Timeouts count as detected, so they were checked by hand: apply the mutant to the source, run the owning test file under a 60 s guard, and restore. The 33 tracker.ts Timeouts of the Task 3 run all fail tests, and the 3 more in final run 1 were killed by an assertion in that run; most make a test hit Vitest's 5 s timeout, and several 5 s hangs push one command run past Stryker's limit. Four tracker.ts mutants never finish at all (104:69, 109:9, 158:14, and 169:14 each replace a block with `{}`, so `whenIdle` loops on microtasks and starves even Vitest's own timeout); All 23 clock.ts Timeouts of final run 1 fail `clock.test.ts` with the mutant applied; 22 fail within 7 s, and 137:16 (the `advance` loop body emptied to `for (;;) {}`) never finishes. Most fail `clock.test.ts` in under a second but reach Stryker's limit in the full 13-file run, where tests in other files that drive the broken clock hang. The split between Killed and Timeout moves a little from run to run with load (5 mutants moved from Killed to Timeout between the Task 3 run and final run 1); the detected set does not.

**Dependencies.** The two Stryker packages are root dev dependencies only and are not published. Stryker brings in Babel 8, and `@react-native/codegen` declares the peer `@babel/core: '*'`, which pnpm's `autoInstallPeers` would resolve to the newest Babel in the graph. A scoped override in `pnpm-workspace.yaml`, `'@react-native/codegen>@babel/core': ^7.0.0`, keeps React Native's codegen on Babel 7.

**Tests added.** In `clock.test.ts`: "lists timers by due time with ties by id, omitting label and repeatMs when absent"; "repeats an interval every ms milliseconds, and a zero-ms interval every millisecond"; "re-arms an interval behind a timer already due at the same time, and reports when it was re-armed"; "allows exactly MAX_FIRINGS_PER_ADVANCE firings in one advance"; "names the five busiest labels in CLOCK_RUNAWAY, busiest first, with unlabeled timers by id"; "fires a re-armed interval before a later-due timer that was scheduled before the re-arm"; the fast-check property "timeouts and re-arming intervals fire in due order, with ties in the order they were scheduled or re-armed"; and, under `createRealClock with fake timers`, "lists real timers by due time with ties by id, and reads now from Date", "gives a real timeout scheduled after an interval the next id", "runs a real timeout once at its due time and drops it", "re-arms a real interval and reports its new due time", and "never runs a cleared real timeout or interval, and ignores unknown ids". In `tracker.test.ts`: "marks a port with a hidden, permanent global-registry symbol"; "passes non-promise results through untouched"; "passes symbol-keyed methods through unwrapped"; "calls a method replaced on the port after it was first read"; "returns a callable unsubscribe from onChange when disabled"; "in idle mode, waits out fake-backed work instead of reporting quiescence"; "reports quiescence after QUIESCENT_STABLE_YIELDS unchanged samples, restarting the count when real work interleaves"; "settles once a short real timer fires, though timers send no change"; a new assertion on the warning text in the listener-isolation test; and, under `createTracker with frozen wall-clock time`, "reports an effect tracked without options as real, with its wall-clock age", "counts a real timer due exactly at the threshold, names unlabeled timers by id, and ages timers from when they were scheduled", "reports nextTimerInMs from the manual clock's current time, and never for a real clock", "wakes on a tracked change instead of waiting for the next poll", "returns at once with the pending list when timeoutMs is 0", "times out at its deadline rather than on the next poll after it", "re-samples unchanged real work on a bounded poll instead of spinning", and "gives up after one sample in quiescent mode when timeoutMs is 0". Before it was added, each was shown to fail against its mutant applied by hand. The bounded-poll test asserts 3 to 12 samples in 100 ms rather than pinning the 16 ms poll, which docs/api.md doesn't document; it still kills tracker.ts:173:49 (`Math.max(0, …)` → `Math.min(0, …)`, a zero-delay spin that samples 102 times).

**Bugs fixed.** None. Every new test passed on the unmutated source, so `clock.ts` and `tracker.ts` are unchanged and there is no `@ironbird/core` changeset.

### Equivalent mutants

| Location | Mutator | Replacement | Why no test can observe it |
|---|---|---|---|
| clock.ts:72:13 | ConditionalExpression | `if (entry)` → `if (true)` in the real clock's interval callback | A real interval's callback runs only while its handle is live, and clearing removes the entry and clears the handle together, so the entry always exists when the guard runs. |
| clock.ts:113:79 | EqualityOperator | `entry.seq < best.seq` → `entry.seq <= best.seq` | Every `seq` is unique (`nextSeq++` on scheduling and on every interval re-arm), so two entries never have equal seqs. |
| tracker.ts:59:57 | ConditionalExpression | `item.kind === 'effect'` → `true` in `stabilityKey` | `stabilityKey` runs only when every pending item is fake, and timer items are always real, so the timer branch is unreachable. |
| tracker.ts:59:98 | StringLiteral | `` `t:${item.label}` `` → empty template | The same unreachable timer branch. |
| tracker.ts:111:15 | BlockStatement | `finally { off(); }` → `{}` in `waitForChangeOrSleep` | The leaked internal listener only resolves a promise that has already settled. The public API exposes no listener count, so only retained memory differs. |
| tracker.ts:112:7 | CallExpression | `off()` → `;` | Same as the row above. |
| tracker.ts:117:34 | UpdateOperator | `nextEffectId++` → `nextEffectId--` | Effect ids stay unique within a tracker (1, 0, -1, …), and they are never exposed. |
| tracker.ts:152:39 | StringLiteral | default `mode = 'idle'` → `mode = ""` | Every mode other than `'quiescent'` behaves as idle. |
| tracker.ts:162:50 | StringLiteral | `.join('\|')` → `.join("")` | Every stability key is `e<digits>`, so the joined string identifies the same set of items with or without a separator. |

### Survivors left alive

These can be observed, but only in another JavaScript engine or with an input no port produces. They count against the score.

| Location | Mutator | Replacement | Why it is not pinned |
|---|---|---|---|
| clock.ts:87:93 | ArithmeticOperator | `a.id - b.id` → `a.id + b.id`, the real clock's `timers()` tie-break | Not observable in Node. Before sorting, the array is always in id order (Map insertion order is id order, and re-arming mutates entries in place), and V8's sort compares ties only as (later, earlier), where both expressions are positive. Fuzzed over 20,000 random arrays on Node 26.10 and 22.14 with no difference. The spec does not fix the order in which a sort calls its comparator, so in another engine such as Hermes the mutant could reorder tied timers. |
| clock.ts:129:93 | ArithmeticOperator | `a.id - b.id` → `a.id + b.id`, the manual clock's `timers()` tie-break | Same as the row above. |
| tracker.ts:31:10 | ConditionalExpression | `typeof value === 'object'` → `true` in `isThenable` | It differs only when a port method returns a callable thenable: a function with a `then` method. No port does, and whether such a function should be tracked as a promise (Promises/A+ says it should) is a decision to make deliberately, not to pin by test. |

`pnpm mutation` is not part of CI (D8); rerun it after changing `clock.ts` or `tracker.ts`.

## Follow-ups

- The shrunk counterexamples are 4 steps for nine seeds and 5 for seed 2 (its 300 ms advance shrank to two advances of 103 and 197 ms), no longer than the five-step witness. None needs `setEcho`: the fake's default is auto, which echoes 500 ms after the submission resolves, and a 300 ms advance stays before that.
- The gate takes seconds, not the minutes the design expected, so it could run in CI; D7 keeps it out of `pnpm test` and CI anyway, with the smoke as the per-commit check. Revisit if the gate is ever wanted per commit.
- No plan 1 bugs were found by the gate, and the smoke seed needed no re-pin.
