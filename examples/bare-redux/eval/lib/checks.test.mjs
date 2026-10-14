import { describe, expect, it } from 'vitest';
import { acceptanceCheck, bridgeDevOnlyCheck, CHECKS, commandsCheck, decide, releaseBundleCheck, serveCheck } from './checks.mjs';

const scan = (exitCode, found = [], scanned = 1) => ({ scan: { exitCode, report: { scanned, found } } });
const hit = { file: 'dev.ios.js', offset: 5 };

describe('serveCheck', () => {
  it('passes when status lists the headless target', () => {
    expect(serveCheck({ status: { targets: [{ id: 'headless' }, { id: 'ios' }] } })).toEqual({ id: 'serve', pass: true, detail: 'ironbird serve loaded the headless entry; status lists the headless target' });
  });

  it('fails with a reason when serve did not start, or status has no headless target', () => {
    expect(serveCheck({ error: 'ironbird serve exited (2) before it was ready; see serve.log' })).toEqual({ id: 'serve', pass: false, detail: 'ironbird serve did not start: ironbird serve exited (2) before it was ready; see serve.log' });
    expect(serveCheck({ status: { targets: [{ id: 'ios' }] } }).detail).toBe('ironbird status lists no headless target (targets: ios)');
    expect(serveCheck({}).detail).toBe('ironbird status lists no headless target (targets: none)');
  });

  it('fails on odd input instead of throwing or passing', () => {
    for (const odd of [undefined, null, 'headless', { status: null }, { status: { targets: 'headless' } }, { status: { targets: [null, {}, { id: 3 }] } }]) {
      expect(serveCheck(odd).pass).toBe(false);
    }
  });
});

describe('commandsCheck', () => {
  it('passes when every command acceptance.yaml sends is listed', () => {
    expect(commandsCheck({ listed: { 'notes.add': {}, 'notes.clear': {} }, required: ['notes.add'] })).toEqual({ id: 'commands', pass: true, detail: 'lists 2 commands, including every command acceptance.yaml sends: notes.add' });
  });

  it('names the missing commands, and fails when the command itself failed', () => {
    expect(commandsCheck({ listed: { 'notes.clear': {} }, required: ['notes.add', 'notes.done'] }).detail).toBe('missing notes.add, notes.done (listed: notes.clear)');
    expect(commandsCheck({ listed: {}, required: ['notes.add'] }).detail).toBe('missing notes.add (listed: none)');
    expect(commandsCheck({ required: ['notes.add'], error: 'not run, because ironbird serve did not start' })).toEqual({ id: 'commands', pass: false, detail: 'ironbird commands failed: not run, because ironbird serve did not start' });
  });

  it('does not pass when there is nothing required to check, or no list was printed', () => {
    expect(commandsCheck({ listed: { 'notes.add': {} }, required: [] }).pass).toBe(false);
    expect(commandsCheck({ listed: { 'notes.add': {} } }).pass).toBe(false);
    expect(commandsCheck({ listed: { 'notes.add': {} }, required: [''] }).pass).toBe(false);
    expect(commandsCheck({ required: ['notes.add'] }).pass).toBe(false);
    expect(commandsCheck({ listed: ['notes.add'], required: ['notes.add'] }).pass).toBe(false);
    expect(commandsCheck(undefined).pass).toBe(false);
  });
});

describe('acceptanceCheck', () => {
  it('passes a run that exited 0 with passed: true', () => {
    expect(acceptanceCheck({ exitCode: 0, result: { passed: true, stepsRun: 7, durationMs: 41 } })).toEqual({ id: 'acceptance', pass: true, detail: 'passed: 7 steps in 41 ms' });
  });

  it('fails a failed step, an error before any step, and a run that never happened', () => {
    const failedStep = { index: 3, step: { expect: 'notes.count' }, expected: { equals: 1 }, actual: 0 };
    expect(acceptanceCheck({ exitCode: 4, result: { passed: false, failedStep } }).detail).toBe(`failed at step 3: ${JSON.stringify(failedStep)}`);
    expect(acceptanceCheck({ exitCode: 2, error: { code: 'INVALID_SCENARIO', message: 'bad file' } }).detail).toBe('did not run: INVALID_SCENARIO bad file');
    expect(acceptanceCheck(undefined)).toEqual({ id: 'acceptance', pass: false, detail: 'not run, because ironbird serve did not start' });
    expect(acceptanceCheck({ exitCode: 3, result: { passed: true, stepsRun: 1, durationMs: 1 } }).pass).toBe(false);
  });

  it('fails a pass that ran no step, a pass that carries a failed step, and odd results', () => {
    expect(acceptanceCheck({ exitCode: 0, result: { passed: true, stepsRun: 0, durationMs: 1 } }).pass).toBe(false);
    expect(acceptanceCheck({ exitCode: 0, result: { passed: true, durationMs: 1 } }).pass).toBe(false);
    expect(acceptanceCheck({ exitCode: 0, result: { passed: true, stepsRun: 2, failedStep: { index: 1 } } }).pass).toBe(false);
    expect(acceptanceCheck({ exitCode: 0, result: {} }).pass).toBe(false);
    expect(acceptanceCheck({ exitCode: 0, result: { passed: 'true', stepsRun: 2 } }).pass).toBe(false);
    expect(acceptanceCheck({ exitCode: 0 }).pass).toBe(false);
    expect(acceptanceCheck({}).pass).toBe(false);
    expect(acceptanceCheck('passed').pass).toBe(false);
  });
});

describe('bridgeDevOnlyCheck', () => {
  it('passes when the source calls startBridge and the development bundle contains the bridge (verify-bundle exits 1)', () => {
    expect(bridgeDevOnlyCheck({ callers: ['src/ironbird/device.ts'], devBundle: scan(1, [hit]) })).toEqual({
      id: 'bridgeDevOnly',
      pass: true,
      detail: 'startBridge is called in src/ironbird/device.ts, and the development bundle contains the bridge',
    });
  });

  it('fails with a reason for no caller, a failed bundle, a bundle without the bridge, and an unreadable scan', () => {
    expect(bridgeDevOnlyCheck({ callers: [], devBundle: scan(1, [hit]) }).detail).toBe('no source file outside node_modules imports startBridge from @ironbird/react-native and calls it');
    expect(bridgeDevOnlyCheck({ callers: ['a.ts'], devBundle: { error: 'react-native bundle --dev true exited 1: boom' } }).detail).toBe('the development bundle failed: react-native bundle --dev true exited 1: boom');
    expect(bridgeDevOnlyCheck({ callers: ['a.ts'], devBundle: scan(0) }).detail).toBe('the development bundle does not contain the bridge, so it is never started; check that the entry file reaches startBridge');
    expect(bridgeDevOnlyCheck({ callers: ['a.ts'], devBundle: { scan: { exitCode: 2 } } }).detail).toBe('verify-bundle exited 2 on the development bundle');
  });

  it('never takes exit 1 alone as the bridge: a scanner error also exits 1', () => {
    expect(bridgeDevOnlyCheck({ callers: ['a.ts'], devBundle: { scan: { exitCode: 1 } } }).pass).toBe(false);
    expect(bridgeDevOnlyCheck({ callers: ['a.ts'], devBundle: { scan: { exitCode: 1, report: { error: { code: 'INTERNAL' } } } } }).pass).toBe(false);
    expect(bridgeDevOnlyCheck({ callers: ['a.ts'], devBundle: scan(1, []) }).pass).toBe(false);
    expect(bridgeDevOnlyCheck({ callers: ['a.ts'], devBundle: scan(1, [{ file: 'x.js' }]) }).pass).toBe(false);
  });

  it('fails on odd input', () => {
    expect(bridgeDevOnlyCheck(undefined).pass).toBe(false);
    expect(bridgeDevOnlyCheck({ callers: ['a.ts'] }).pass).toBe(false);
    expect(bridgeDevOnlyCheck({ callers: 'a.ts', devBundle: scan(1, [hit]) }).pass).toBe(false);
    expect(bridgeDevOnlyCheck({ callers: [''], devBundle: scan(1, [hit]) }).pass).toBe(false);
  });
});

describe('releaseBundleCheck', () => {
  it('passes a scanned release bundle without the bridge', () => {
    expect(releaseBundleCheck({ releaseBundle: scan(0) })).toEqual({ id: 'releaseBundleClean', pass: true, detail: 'the release bundle does not contain the bridge' });
  });

  it('fails a bundle with the bridge, a failed bundle, an empty scan, and an unreadable scan', () => {
    expect(releaseBundleCheck({ releaseBundle: scan(1, [{ file: 'build/release.ios.js', offset: 10 }]) }).detail).toBe('the release bundle contains the bridge at build/release.ios.js:10');
    expect(releaseBundleCheck({ releaseBundle: { error: 'no index.js' } }).detail).toBe('the release bundle failed: no index.js');
    expect(releaseBundleCheck({ releaseBundle: scan(0, [], 0) }).detail).toBe('verify-bundle scanned nothing');
    expect(releaseBundleCheck({ releaseBundle: { scan: { exitCode: 2 } } }).detail).toBe('verify-bundle exited 2 on the release bundle');
  });

  it('never passes without a valid report, whatever the exit code', () => {
    expect(releaseBundleCheck({ releaseBundle: { scan: { exitCode: 0 } } }).pass).toBe(false);
    expect(releaseBundleCheck({ releaseBundle: { scan: { exitCode: 0, report: {} } } }).pass).toBe(false);
    expect(releaseBundleCheck({ releaseBundle: { scan: { exitCode: 0, report: { scanned: 1 } } } }).pass).toBe(false);
    expect(releaseBundleCheck({ releaseBundle: { scan: { exitCode: 0, report: { error: { code: 'INTERNAL' } } } } }).pass).toBe(false);
    expect(releaseBundleCheck({ releaseBundle: { scan: { report: { scanned: 1, found: [] } } } }).pass).toBe(false);
    expect(releaseBundleCheck({ releaseBundle: scan(0, [hit]) }).pass).toBe(false);
    expect(releaseBundleCheck({ releaseBundle: scan(1, []) }).pass).toBe(false);
    expect(releaseBundleCheck({}).pass).toBe(false);
    expect(releaseBundleCheck(undefined).pass).toBe(false);
  });
});

describe('decide', () => {
  const all = (pass) => CHECKS.map((id) => ({ id, pass, detail: '' }));

  it('passes only when all five checks pass', () => {
    expect(decide(all(true))).toEqual({ passed: true, score: '5/5' });
    const four = all(true);
    four[2] = { ...four[2], pass: false };
    expect(decide(four)).toEqual({ passed: false, score: '4/5' });
  });

  it('never passes a grade that is missing a check', () => {
    expect(decide(all(true).slice(0, 4))).toEqual({ passed: false, score: '4/5' });
    expect(decide([])).toEqual({ passed: false, score: '0/5' });
    expect(decide(undefined)).toEqual({ passed: false, score: '0/5' });
  });

  it('does not count a duplicated or unknown check toward a pass', () => {
    const duplicated = [...all(true).slice(0, 4), { id: 'serve', pass: true, detail: '' }];
    expect(decide(duplicated).passed).toBe(false);
    expect(decide([...all(true), { id: 'extra', pass: true, detail: '' }]).passed).toBe(false);
    expect(decide(all(true).map((check) => ({ ...check, pass: 'yes' }))).passed).toBe(false);
  });
});
