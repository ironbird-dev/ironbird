// Benchmarks ironbird's own overhead against the checkout example app, headless.
//
// Two of the rows below run in process, against the same target, but exercise different paths
// through the headless target's settle logic:
//
//   - "headless dispatch, no pending effect (floor)" dispatches `cart.clear`, a pure reducer step
//     with no pending fake effect. The tracker's `whenIdle` sees no pending items and returns on
//     its first check, so this row is a floor: the raw cost of dispatch + snapshot + event slice,
//     never entering the quiescent settle loop that a step with a pending effect pays.
//   - "headless dispatch with pending fake effect" dispatches `payment.start`, which leaves the
//     fake reader's `collectPayment` pending on the manual clock. Settling now goes through the
//     quiescent branch: three macrotask yields (QUIESCENT_STABLE_YIELDS in
//     packages/core/src/tracker.ts) before `whenIdle` reports `quiescent: true`. This is the path
//     most real commands take, and is what the spec's G1 budget ("ironbird overhead per headless
//     command, excluding app logic, < 5 ms p95") should be measured against.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHeadlessTarget, loadTypeScriptModule, startDaemon, writeDaemonInfo, removeDaemonInfo } from '../dist/index.js';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.resolve(here, '../../../examples/checkout');
const bin = path.resolve(here, '../dist/bin.js');
const check = process.argv.includes('--check');

const percentile = (samples, p) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const loaded = await loadTypeScriptModule(path.join(example, 'src/ironbird/headless.ts'), { outDir: path.join(example, '.ironbird/cache'), label: 'bench', forbidden: ['react-native'] });
const target = await createHeadlessTarget({ definition: loaded.exports.default, appId: 'bench', clockStart: '2026-01-01T00:00:00.000Z', settleTimeoutMs: 5000, env: {}, log: () => {} });

let daemon;
try {
  const inProcess = [];
  for (let i = 0; i < 500; i += 1) {
    const started = performance.now();
    await target.run('dispatch', { name: 'cart.clear', payload: {}, path: 'cart' });
    inProcess.push(performance.now() - started);
  }

  await target.run('dispatch', { name: 'cart.addItem', payload: { sku: 'cut-45', qty: 1 }, path: 'cart' });
  const inProcessQuiescent = [];
  let firstQuiescentResult;
  for (let i = 0; i < 500; i += 1) {
    const started = performance.now();
    const result = await target.run('dispatch', { name: 'payment.start', payload: { method: 'card' }, path: 'payment' });
    inProcessQuiescent.push(performance.now() - started);
    if (i === 0) firstQuiescentResult = result;
    // Outside the timed span: drive the manual clock so the fake reader, the fake API, and the
    // server echo all fire and the order completes, freeing the cart for the next iteration's
    // `payment.start` (the reducer allows it again once payment is no longer in progress).
    await target.run('clockAdvance', { ms: 2_000 });
  }
  if (!firstQuiescentResult?.settle?.quiescent) {
    throw new Error(
      `Expected the first measured "payment.start" dispatch to settle via the quiescent branch (settle.quiescent === true), got ${JSON.stringify(firstQuiescentResult?.settle)}. This row is meant to measure the quiescent settle path, not the no-pending-effect floor.`,
    );
  }

  daemon = await startDaemon({ host: '127.0.0.1', port: 0, version: 'bench', headless: target, defaultTarget: 'headless', log: () => {} });
  await writeDaemonInfo(path.join(example, '.ironbird'), { url: daemon.url, pid: process.pid, startedAt: Date.now(), version: 'bench', defaultTarget: 'headless' });

  const http = [];
  for (let i = 0; i < 500; i += 1) {
    const started = performance.now();
    await fetch(`${daemon.url}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'dispatch', params: { name: 'cart.clear', path: 'cart' } }) }).then((r) => r.json());
    http.push(performance.now() - started);
  }

  const cli = [];
  for (let i = 0; i < 40; i += 1) {
    const started = performance.now();
    await exec('node', [bin, 'state', 'cart'], { cwd: example, env: { ...process.env, IRONBIRD_TOKEN: undefined } });
    cli.push(performance.now() - started);
  }

  const rows = [
    ['headless dispatch, no pending effect (floor)', inProcess, 5],
    ['headless dispatch with pending fake effect', inProcessQuiescent, 5],
    ['headless dispatch over HTTP', http, null],
    ['CLI invocation end to end', cli, 300],
  ];
  let failed = false;
  console.log('measurement                                  p50 ms   p95 ms   budget');
  for (const [name, samples, budget] of rows) {
    const p50 = percentile(samples, 50).toFixed(2);
    const p95 = percentile(samples, 95);
    const ok = budget === null || p95 < budget;
    if (!ok) failed = true;
    console.log(`${name.padEnd(44)} ${p50.padStart(6)} ${p95.toFixed(2).padStart(8)}   ${budget === null ? 'n/a' : `${budget} ${ok ? 'ok' : 'MISSED'}`}`);
  }
  if (check && failed) process.exitCode = 1;
} finally {
  await removeDaemonInfo(path.join(example, '.ironbird'));
  if (daemon) await daemon.close();
  await target.dispose();
}
