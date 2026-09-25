// The M1 measurement harness (docs/testing-strategy.md, "Reliability indicators"): drives a
// running daemon and app through `step`, takes a second capture one second after each step's
// screenshot, and counts the first capture as stale when the two differ. Latency is the wall
// time of the `step` request. Overhead is that latency minus the settle wait the bridge
// reports, which is the time the app itself took to become idle (its own timers, promises, and
// renders); what remains is ironbird's cost per step: transport, dispatch, and the host
// screenshot. The M1 latency criterion is judged on overhead, because an app that is slow by
// design would otherwise set the number (docs/evals/m1-remote-mode.md, "Gate decision"). Runs
// once per motion arm so the Q5 comparison comes from one build in one session. This is a
// measurement, not a test: the numbers are recorded in docs/evals/m1-remote-mode.md.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.resolve(here, '..');
const artifacts = path.join(example, '.ironbird');

const args = parseArgs(process.argv.slice(2));
const target = args.target ?? 'ios';
const steps = Number(args.steps ?? 300);
const arms = args.motion === 'full' || args.motion === 'reduced' ? [args.motion] : ['full', 'reduced'];
const stalePixelFraction = 0.001;
const pixelTolerance = 32;
// The roadmap's M1 exit criterion, which is defined for the iOS Simulator only.
const budget = { platform: 'ios', maxStaleRate: 0.01, maxOverheadP95Ms: 1_500 };

// Every step changes the screen: the count, the subtotal, the header image, or the receipt.
// `saved` skips the reader, but the payment still spends about 800 ms in the fake API's own
// timers. That time lands in the settle wait, so it shows in the raw latency and not in overhead.
const CYCLE = [
  ['cart.addItem', { sku: 'cut-45', qty: 1 }],
  ['cart.addItem', { sku: 'shampoo-12', qty: 1 }],
  ['cart.clear', {}],
  ['cart.addItem', { sku: 'beard-20', qty: 1 }],
  ['payment.start', { method: 'saved' }],
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    out[key.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

async function daemonInfo() {
  try {
    return JSON.parse(await readFile(path.join(artifacts, 'daemon.json'), 'utf8'));
  } catch {
    throw new Error('No .ironbird/daemon.json; run `ironbird serve` in examples/checkout first');
  }
}

async function rpc(url, op, params = {}, targetId) {
  const response = await fetch(`${url}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, target: targetId, params }) });
  const envelope = await response.json();
  if (!envelope.ok) throw new Error(`${op} failed: ${envelope.error.code}: ${envelope.error.message}`);
  return envelope.result;
}

// Nearest rank: the smallest sample with at least p percent of the samples at or below it.
const percentile = (samples, p) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const spread = (samples) => ({ p50: percentile(samples, 50), p95: percentile(samples, 95) });

async function pixelDifference(fileA, fileB) {
  const a = PNG.sync.read(await readFile(fileA));
  const b = PNG.sync.read(await readFile(fileB));
  if (a.width !== b.width || a.height !== b.height) return 1;
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (delta > pixelTolerance) differing += 1;
  }
  return differing / (a.data.length / 4);
}

// The status bar clock would make every capture look stale, so it is frozen for the run.
async function freezeStatusBar(platform, device) {
  if (platform === 'ios') {
    await exec('xcrun', ['simctl', 'status_bar', device, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100']);
    return async () => exec('xcrun', ['simctl', 'status_bar', device, 'clear']);
  }
  const demo = (...pairs) => exec('adb', ['-s', device, 'shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', ...pairs]);
  await exec('adb', ['-s', device, 'shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
  await demo('-e', 'command', 'enter');
  await demo('-e', 'command', 'clock', '-e', 'hhmm', '0941');
  await demo('-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false');
  await demo('-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4');
  await demo('-e', 'command', 'notifications', '-e', 'visible', 'false');
  return async () => demo('-e', 'command', 'exit');
}

async function resolveDevice(platform) {
  if (args.device) return args.device;
  if (platform === 'ios') {
    const { stdout } = await exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
    const booted = Object.values(JSON.parse(stdout).devices).flat().filter((d) => d.state === 'Booted');
    if (booted.length !== 1) throw new Error(`Expected one booted simulator, found ${booted.length}; pass --device`);
    return booted[0].udid;
  }
  const { stdout } = await exec('adb', ['devices']);
  const serials = stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === 'device').map((p) => p[0]);
  if (serials.length !== 1) throw new Error(`Expected one adb device, found ${serials.length}; pass --device`);
  return serials[0];
}

async function runArm(url, motion, runDir) {
  await rpc(url, 'dispatch', { name: 'ui.setMotion', payload: { motion }, settle: true }, target);
  const records = [];
  for (let i = 0; i < steps; i += 1) {
    const [name, payload] = CYCLE[i % CYCLE.length];
    const startedAt = performance.now();
    const result = await rpc(url, 'step', { name, payload, path: 'cart.subtotalCents', device: args.device }, target);
    const latencyMs = performance.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const second = await rpc(url, 'screenshot', { device: args.device }, target);
    const difference = await pixelDifference(result.screenshot.path, second.path);
    const waitedMs = result.settle?.waitedMs ?? null;
    records.push({ index: i, motion, name, latencyMs, overheadMs: latencyMs - (waitedMs ?? 0), settled: result.settle?.idle === true, waitedMs, stale: difference > stalePixelFraction, difference, first: result.screenshot.path, second: second.path });
    process.stdout.write(`\r${motion.padEnd(8)} ${String(i + 1).padStart(3)}/${steps}  ${name.padEnd(14)} ${latencyMs.toFixed(0).padStart(5)} ms  ${records[records.length - 1].stale ? 'STALE' : 'ok   '}`);
  }
  process.stdout.write('\n');
  await writeFile(path.join(runDir, `steps-${motion}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const latency = spread(records.map((r) => r.latencyMs));
  const overhead = spread(records.map((r) => r.overheadMs));
  const settleWait = spread(records.map((r) => r.waitedMs ?? 0));
  const byCommand = {};
  for (const name of new Set(records.map((r) => r.name))) {
    const own = records.filter((r) => r.name === name);
    byCommand[name] = { steps: own.length, staleCount: own.filter((r) => r.stale).length, latencyMs: spread(own.map((r) => r.latencyMs)), overheadMs: spread(own.map((r) => r.overheadMs)), settleWaitMs: spread(own.map((r) => r.waitedMs ?? 0)) };
  }
  return {
    motion,
    steps: records.length,
    staleCount: records.filter((r) => r.stale).length,
    staleRate: records.filter((r) => r.stale).length / records.length,
    unsettledCount: records.filter((r) => !r.settled).length,
    unsettledRate: records.filter((r) => !r.settled).length / records.length,
    latencyP50Ms: latency.p50,
    latencyP95Ms: latency.p95,
    overheadP50Ms: overhead.p50,
    overheadP95Ms: overhead.p95,
    settleWaitP50Ms: settleWait.p50,
    settleWaitP95Ms: settleWait.p95,
    byCommand,
  };
}

const info = await daemonInfo();
const status = await rpc(info.url, 'status');
const connected = status.targets.find((t) => t.id === target);
if (!connected) throw new Error(`Target ${target} is not connected (targets: ${status.targets.map((t) => t.id).join(', ') || 'none'}); start the app first`);
const platform = connected.platform;
const device = await resolveDevice(platform);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
const runDir = path.join(artifacts, 'metrics', `${stamp}-${target}`);
await mkdir(runDir, { recursive: true });
const restore = await freezeStatusBar(platform, device);
const summary = { target, platform, device, steps, startedAt: new Date().toISOString(), thresholds: { stalePixelFraction, pixelTolerance }, budget, arms: [] };
try {
  for (const motion of arms) summary.arms.push(await runArm(info.url, motion, runDir));
} finally {
  await restore().catch(() => undefined);
}
await writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

console.log(`\nresults for ${target} (${device}), ${steps} steps per arm, written to ${path.relative(example, runDir)}\n`);
console.log('motion    stale    unsettled   latency p50/p95 ms   overhead p50/p95 ms   stale rate   budget');
for (const arm of summary.arms) {
  // The budget is the iOS exit criterion; M1 defines none for Android, so no verdict is printed there.
  const verdict = platform !== budget.platform ? 'n/a' : arm.staleRate <= budget.maxStaleRate && arm.overheadP95Ms < budget.maxOverheadP95Ms ? 'ok' : 'MISS';
  const pair = (a, b) => `${a.toFixed(0)}/${b.toFixed(0)}`.padStart(18);
  console.log(`${arm.motion.padEnd(9)} ${String(arm.staleCount).padStart(5)}    ${String(arm.unsettledCount).padStart(9)}   ${pair(arm.latencyP50Ms, arm.latencyP95Ms)}   ${pair(arm.overheadP50Ms, arm.overheadP95Ms)}    ${(arm.staleRate * 100).toFixed(2).padStart(9)}%   ${verdict}`);
  for (const [name, stats] of Object.entries(arm.byCommand)) {
    console.log(`  ${name.padEnd(16)} ${String(stats.steps).padStart(4)} steps   latency ${pair(stats.latencyMs.p50, stats.latencyMs.p95).trim().padStart(10)}   overhead ${pair(stats.overheadMs.p50, stats.overheadMs.p95).trim().padStart(10)}   settle wait ${pair(stats.settleWaitMs.p50, stats.settleWaitMs.p95).trim().padStart(10)}   stale ${stats.staleCount}`);
  }
}
