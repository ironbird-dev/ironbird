// The M1 measurement harness (docs/testing-strategy.md, "Reliability indicators"): drives a
// running daemon and app through `step`, takes a second capture one second after each step's
// screenshot, and counts the first capture as stale when the two differ. Latency is the wall
// time of the `step` request. Runs once per motion arm so the Q5 comparison comes from one
// build in one session. This is a measurement, not a test: the numbers are recorded in
// docs/evals/m1-remote-mode.md.
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

// Every step changes the screen: the count, the subtotal, the header image, or the receipt.
// `saved` skips the reader, so a payment completes in about a second and stays inside the
// latency budget the harness is measuring ironbird against, not the app's own effects.
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

const percentile = (samples, p) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

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
    records.push({ index: i, motion, name, latencyMs, settled: result.settle?.idle === true, waitedMs: result.settle?.waitedMs ?? null, stale: difference > stalePixelFraction, difference, first: result.screenshot.path, second: second.path });
    process.stdout.write(`\r${motion.padEnd(8)} ${String(i + 1).padStart(3)}/${steps}  ${name.padEnd(14)} ${latencyMs.toFixed(0).padStart(5)} ms  ${records[records.length - 1].stale ? 'STALE' : 'ok   '}`);
  }
  process.stdout.write('\n');
  await writeFile(path.join(runDir, `steps-${motion}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const latencies = records.map((r) => r.latencyMs);
  return {
    motion,
    steps: records.length,
    staleCount: records.filter((r) => r.stale).length,
    staleRate: records.filter((r) => r.stale).length / records.length,
    unsettledCount: records.filter((r) => !r.settled).length,
    unsettledRate: records.filter((r) => !r.settled).length / records.length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
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
const summary = { target, platform, device, steps, startedAt: new Date().toISOString(), arms: [] };
try {
  for (const motion of arms) summary.arms.push(await runArm(info.url, motion, runDir));
} finally {
  await restore().catch(() => undefined);
}
await writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

console.log(`\nresults for ${target} (${device}), ${steps} steps per arm, written to ${path.relative(example, runDir)}\n`);
console.log('motion    stale    unsettled   p50 ms   p95 ms   stale rate   budget');
for (const arm of summary.arms) {
  const ok = arm.staleRate <= 0.01 && arm.latencyP95Ms < 1_500 ? 'ok' : 'MISS';
  console.log(`${arm.motion.padEnd(9)} ${String(arm.staleCount).padStart(5)}    ${String(arm.unsettledCount).padStart(9)}   ${arm.latencyP50Ms.toFixed(0).padStart(6)}   ${arm.latencyP95Ms.toFixed(0).padStart(6)}   ${(arm.staleRate * 100).toFixed(2).padStart(9)}%   ${ok}`);
}
