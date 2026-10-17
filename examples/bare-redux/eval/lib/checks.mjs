// The five checks of integration-exercise/CHECKLIST.md (M5 design D11), as pure judgments over what
// the grader observed. grade-project.mjs gathers the observations. Each returns { id, pass, detail };
// a missing or odd observation fails with a reason, never passes by default.

export const CHECKS = ['serve', 'commands', 'acceptance', 'bridgeDevOnly', 'releaseBundleClean'];

const verdict = (id, pass, detail) => ({ id, pass, detail });

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value !== '';

/**
 * A verify-bundle observation as a valid report, or why not. A scanner error also exits 1, so an
 * exit code alone never counts: the report must parse into { scanned, found: [{ file, offset }] }.
 */
function readScan(bundle, what) {
  if (!isRecord(bundle)) return { problem: `no ${what} observation` };
  if (bundle.error !== undefined) return { problem: `the ${what} failed: ${bundle.error}` };
  const scan = bundle.scan;
  if (!isRecord(scan) || !Number.isInteger(scan.exitCode)) return { problem: `no verify-bundle result for the ${what}` };
  const { exitCode, report } = scan;
  const valid =
    isRecord(report) &&
    Number.isInteger(report.scanned) &&
    report.scanned >= 0 &&
    Array.isArray(report.found) &&
    (report.found.length === 0 || report.scanned >= 1) &&
    report.found.every((hit) => isRecord(hit) && isNonEmptyString(hit.file) && Number.isInteger(hit.offset));
  if (!valid) return { problem: `verify-bundle exited ${exitCode} on the ${what}` };
  return { exitCode, report };
}

/** 1. `ironbird serve` loads the headless entry: it started, and `ironbird status` lists `headless`. */
export function serveCheck(observation) {
  const { error, status } = isRecord(observation) ? observation : {};
  if (error) return verdict('serve', false, `ironbird serve did not start: ${error}`);
  const targets = Array.isArray(status?.targets) ? status.targets : [];
  const ids = targets.map((target) => target?.id).filter(isNonEmptyString);
  if (ids.includes('headless')) return verdict('serve', true, 'ironbird serve loaded the headless entry; status lists the headless target');
  return verdict('serve', false, `ironbird status lists no headless target (targets: ${ids.join(', ') || 'none'})`);
}

/** 2. `ironbird commands` lists the declared commands: every command acceptance.yaml sends. */
export function commandsCheck(observation) {
  const { listed, required, error } = isRecord(observation) ? observation : {};
  if (error) return verdict('commands', false, `ironbird commands failed: ${error}`);
  if (!Array.isArray(required) || required.length === 0 || !required.every(isNonEmptyString)) {
    return verdict('commands', false, 'no commands to check: acceptance.yaml sends none the grader could read');
  }
  if (!isRecord(listed)) return verdict('commands', false, 'ironbird commands printed no command list');
  const names = Object.keys(listed);
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length === 0) return verdict('commands', true, `lists ${names.length} commands, including every command acceptance.yaml sends: ${required.join(', ')}`);
  return verdict('commands', false, `missing ${missing.join(', ')} (listed: ${names.join(', ') || 'none'})`);
}

/** 3. The provided acceptance scenario passes headlessly: exit 0, passed: true, and at least one step run. */
export function acceptanceCheck(run) {
  if (!isRecord(run)) return verdict('acceptance', false, 'not run, because ironbird serve did not start');
  const { exitCode, result, error } = run;
  if (isRecord(result) && result.passed === true && !result.failedStep) {
    if (exitCode !== 0) return verdict('acceptance', false, `exited ${exitCode} with passed: true`);
    if (!Number.isFinite(result.durationMs) || result.durationMs < 0) return verdict('acceptance', false, `passed without a valid durationMs (${JSON.stringify(result.durationMs)})`);
    if (!Number.isInteger(result.stepsRun) || result.stepsRun < 1) return verdict('acceptance', false, `passed without running a step (stepsRun: ${JSON.stringify(result.stepsRun)})`);
    return verdict('acceptance', true, `passed: ${result.stepsRun} steps in ${result.durationMs} ms`);
  }
  if (isRecord(result?.failedStep)) return verdict('acceptance', false, `failed at step ${result.failedStep.index}: ${JSON.stringify(result.failedStep)}`);
  if (isRecord(result)) return verdict('acceptance', false, `exited ${exitCode} with passed: ${JSON.stringify(result.passed)}`);
  return verdict('acceptance', false, `did not run: ${[error?.code, error?.message].filter(Boolean).join(' ') || `exit ${exitCode}`}`);
}

/** 4. The bridge is started under __DEV__ only, part one: the source calls startBridge, and a development bundle contains the bridge (verify-bundle exits 1 with a report that lists it). Part two is check 5. */
export function bridgeDevOnlyCheck(observation) {
  const { callers, devBundle } = isRecord(observation) ? observation : {};
  if (!Array.isArray(callers) || callers.length === 0 || !callers.every(isNonEmptyString)) {
    return verdict('bridgeDevOnly', false, 'no source file outside node_modules imports startBridge from @ironbird/react-native and calls it');
  }
  const scan = readScan(devBundle, 'development bundle');
  if (scan.problem) return verdict('bridgeDevOnly', false, scan.problem);
  if (scan.exitCode === 1 && scan.report.found.length > 0) {
    return verdict('bridgeDevOnly', true, `startBridge is called in ${callers.join(', ')}, and the development bundle contains the bridge`);
  }
  if (scan.exitCode === 0 && scan.report.found.length === 0) {
    return verdict('bridgeDevOnly', false, 'the development bundle does not contain the bridge, so it is never started; check that the entry file reaches startBridge');
  }
  return verdict('bridgeDevOnly', false, `verify-bundle exited ${scan.exitCode} on the development bundle`);
}

/** 5. `verify-bundle` passes on a production bundle: exit 0, at least one file scanned, nothing found. */
export function releaseBundleCheck(observation) {
  const { releaseBundle } = isRecord(observation) ? observation : {};
  const scan = readScan(releaseBundle, 'release bundle');
  if (scan.problem) return verdict('releaseBundleClean', false, scan.problem);
  const { exitCode, report } = scan;
  if (exitCode === 0 && report.found.length === 0) {
    return report.scanned >= 1
      ? verdict('releaseBundleClean', true, 'the release bundle does not contain the bridge')
      : verdict('releaseBundleClean', false, 'verify-bundle scanned nothing');
  }
  if (exitCode === 1 && report.found.length > 0) {
    return verdict('releaseBundleClean', false, `the release bundle contains the bridge at ${report.found.map((hit) => `${hit.file}:${hit.offset}`).join(', ')}`);
  }
  return verdict('releaseBundleClean', false, `verify-bundle exited ${exitCode} on the release bundle`);
}

/** The grade: passed only with all five checks present, each exactly once, and passing. */
export function decide(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const passing = CHECKS.filter((id) => list.filter((check) => check?.id === id).length === 1 && list.find((check) => check?.id === id).pass === true).length;
  return { passed: passing === CHECKS.length && list.length === CHECKS.length, score: `${passing}/${CHECKS.length}` };
}
