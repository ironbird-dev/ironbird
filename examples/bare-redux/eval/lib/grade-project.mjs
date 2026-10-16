// Runs the five CHECKLIST.md checks on one project (M5 design D11) and returns the verdict. Used by
// grade.mjs (a proxy session's copy, a human trial's folder, the selftest on the wired example) and
// by prepare.mjs (the un-integrated template, which must fail every check but the fifth).
//
// The project is graded where it is: the grader starts its own daemon there, on ports the OS picks,
// so it never meets another daemon, and writes .ironbird/ there; bundles and logs go under `out`.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseScenario } from '@ironbird/cli/runner';
import { ironbird, jsonLines, runScenarioFile, startServe } from '../../../checkout/eval/lib/ironbird.mjs';
import { run } from '../../../checkout/eval/lib/proc.mjs';
import { listFiles } from '../../../checkout/eval/lib/tree.mjs';
import { acceptanceCheck, bridgeDevOnlyCheck, commandsCheck, decide, releaseBundleCheck, serveCheck } from './checks.mjs';
import { acceptanceContract, commandNames } from './contract.mjs';
import { entryFile, isSourceFile, SOURCE_SKIP, startBridgeCallers } from './project.mjs';

const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const tail = (text) => String(text ?? '').trim().slice(-1_500);

/** Builds one iOS bundle with the project's own react-native CLI and scans it with the project's own ironbird CLI. */
async function bundleAndScan(project, { dev, entry, out, env }) {
  if (!entry) return { error: 'no index.js, index.ts, index.tsx, or index.jsx at the top of the project' };
  const kind = dev ? 'dev' : 'release';
  const bundle = path.join(out, 'bundles', `${kind}.ios.js`);
  await mkdir(path.dirname(bundle), { recursive: true });
  const assets = await mkdtemp(path.join(os.tmpdir(), 'ironbird-proxy-assets-'));
  try {
    const args = ['bundle', '--platform', 'ios', '--dev', String(dev), '--minify', String(!dev), '--entry-file', entry, '--bundle-output', bundle, '--assets-dest', assets, '--reset-cache'];
    const built = await run(path.join(project, 'node_modules', '.bin', 'react-native'), args, { cwd: project, env, timeoutMs: 15 * 60_000 });
    await writeFile(path.join(out, 'logs', `bundle-${kind}.log`), `${built.stdout}\n${built.stderr}`);
    if (built.code !== 0) return { error: `react-native bundle --dev ${dev} exited ${built.code}: ${tail(built.stderr || built.stdout)}` };
    const scanned = await run(path.join(project, 'node_modules', '.bin', 'ironbird'), ['verify-bundle', bundle, '--json'], { cwd: project, env, timeoutMs: 120_000 });
    return { scan: { exitCode: scanned.code, report: jsonLines(scanned.stdout)[0] } };
  } catch (error) {
    return { error: messageOf(error) };
  } finally {
    await rm(assets, { recursive: true, force: true });
  }
}

/** The five checks on `project`, against the repository's `acceptance` scenario (copied into `out`, so the project's own copy is never used). */
export async function gradeProject({ project, acceptance, out, env = process.env }) {
  await mkdir(path.join(out, 'logs'), { recursive: true });
  const contract = acceptanceContract(parseScenario(await readFile(acceptance, 'utf8'), acceptance));
  const required = commandNames(contract);
  const checks = [];

  let serve;
  let serveError;
  let status;
  try {
    serve = await startServe(project, { env, logFile: path.join(out, 'logs', 'serve.log'), ephemeral: true, timeoutMs: 120_000 });
    status = (await ironbird(project, ['status'], { env, timeoutMs: 30_000 })).lines[0];
  } catch (error) {
    serveError = messageOf(error);
  }
  try {
    checks.push(serveCheck({ error: serveError, status }));
    if (serve && !serveError) {
      const listed = await ironbird(project, ['commands', '--target', 'headless'], { env, timeoutMs: 30_000 });
      const value = listed.lines[0];
      const error = listed.code === 0 ? undefined : (value?.error?.message ?? `exit ${listed.code}: ${tail(listed.stderr)}`);
      checks.push(commandsCheck({ listed: error ? undefined : value, required, error }));
      const copy = path.join(out, 'acceptance.yaml');
      await cp(acceptance, copy);
      checks.push(acceptanceCheck(await runScenarioFile(project, copy, 'headless', { env })));
    } else {
      checks.push(commandsCheck({ required, error: 'not run, because ironbird serve did not start' }));
      checks.push(acceptanceCheck(undefined));
    }
  } finally {
    await serve?.stop();
  }

  const files = await listFiles(project, SOURCE_SKIP);
  const sources = [];
  for (const file of files.filter(isSourceFile)) sources.push({ file, text: await readFile(path.join(project, file), 'utf8') });
  const entry = entryFile(files.filter((file) => !file.includes('/')));
  const devBundle = await bundleAndScan(project, { dev: true, entry, out, env });
  const releaseBundle = await bundleAndScan(project, { dev: false, entry, out, env });
  checks.push(bridgeDevOnlyCheck({ callers: startBridgeCallers(sources), devBundle }));
  checks.push(releaseBundleCheck({ releaseBundle }));
  return { checks, ...decide(checks), contract };
}
