import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureTarget, deniedCalls, finalReport, iosCaptureAfter, lastEdit, outOfFolderPaths, parseTranscript, reportingCall, scenarioResultsOf, stripHeredocs, untrackedWrites } from './transcript.mjs';

const ROOT = '/Users/dev/.ironbird-eval/sessions/1/project';
const HOME = '/Users/dev';

const line = (event) => JSON.stringify(event);
const init = { type: 'system', subtype: 'init', cwd: ROOT, model: 'claude-sonnet-5', mcp_servers: [{ name: 'ironbird', status: 'connected' }], skills: ['ironbird'], plugins: [] };
const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null });
const done = (id, content, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

function transcript(...events) {
  return `${events.map(line).join('\n')}\n`;
}

describe('parseTranscript', () => {
  it('pairs tool uses with their results by id and records positions', () => {
    const parsed = parseTranscript(
      transcript(
        init,
        use('a', 'Edit', { file_path: `${ROOT}/src/core/checkout.ts` }),
        done('a', 'The file has been updated.'),
        use('b', 'mcp__ironbird__ironbird_run_scenario', { path: 'ironbird/scenarios/zero.yaml' }),
        done('b', [{ type: 'text', text: '{"results":[{"passed":true,"artifacts":"/x/.ironbird/runs/2026-10-01T10-00-00-000Z-zero"}]}' }]),
        { type: 'result', subtype: 'success', result: 'Fixed it.', total_cost_usd: 1.25, permission_denials: [{ tool_name: 'Read' }] },
      ),
    );
    expect(parsed.init?.model).toBe('claude-sonnet-5');
    expect(parsed.calls.map((call) => [call.name, call.index, call.resultIndex, call.isError])).toEqual([
      ['Edit', 1, 2, false],
      ['mcp__ironbird__ironbird_run_scenario', 3, 4, false],
    ]);
    expect(parsed.calls[1].resultText).toContain('2026-10-01T10-00-00-000Z-zero');
    expect(finalReport(parsed)).toBe('Fixed it.');
    expect(deniedCalls(parsed)).toBe(1);
  });

  it('survives a session cut off mid-line: no result event, a truncated last line, a tool use without a result', () => {
    const text = `${transcript(init, say('Looking at the reducer.'), use('a', 'Read', { file_path: 'src/core/checkout.ts' }), done('a', 'denied: permission', true), say('The total is set late.'), use('b', 'Bash', { command: 'npm test' }))}{"type":"assistant","mess`;
    const parsed = parseTranscript(text);
    expect(parsed.result).toBeUndefined();
    expect(parsed.events.at(-1)).toMatchObject({ type: 'unparsed' });
    expect(parsed.calls.map((call) => call.resultIndex)).toEqual([3, undefined]);
    expect(finalReport(parsed)).toBe('The total is set late.');
    expect(deniedCalls(parsed)).toBe(1);
  });

  it('returns an empty parse for an empty transcript', () => {
    const parsed = parseTranscript('');
    expect(parsed).toMatchObject({ events: [], init: undefined, result: undefined, calls: [] });
    expect(finalReport(parsed)).toBe('');
    expect(deniedCalls(parsed)).toBe(0);
  });
});

describe('lastEdit', () => {
  it('takes the last successful Edit, Write, MultiEdit, or NotebookEdit result anywhere in the session folder, reverted files included', () => {
    const { calls } = parseTranscript(
      transcript(
        use('a', 'Write', { file_path: 'ironbird/scenarios/zero.yaml' }),
        done('a', 'ok'),
        use('b', 'Edit', { file_path: `${ROOT}/src/core/checkout.ts` }),
        done('b', 'ok'),
        use('c', 'Edit', { file_path: `${ROOT}/src/core/checkout.ts` }),
        done('c', 'String not found', true),
        use('d', 'MultiEdit', { file_path: `${ROOT}/notes.md` }),
        done('d', 'ok'),
      ),
    );
    expect(lastEdit(calls, [ROOT])).toEqual({ index: 7, file: `${ROOT}/notes.md` });
  });

  it('matches edits reported under another spelling of the session folder, and ignores edits outside it', () => {
    const real = `/private${ROOT}`;
    const { calls } = parseTranscript(transcript(use('a', 'Edit', { file_path: `${real}/src/core/checkout.ts` }), done('a', 'ok'), use('b', 'Write', { file_path: '/tmp/x.ts' }), done('b', 'ok')));
    expect(lastEdit(calls, [ROOT, real])).toEqual({ index: 1, file: `${ROOT}/src/core/checkout.ts` });
  });

  it('is -1 when nothing was edited', () => {
    expect(lastEdit([], [ROOT])).toEqual({ index: -1, file: null });
  });
});

describe('scenario results and captures', () => {
  const run = `${ROOT}/.ironbird/runs/2026-10-01T10-00-00-000Z-zero-total`;
  const file = `${ROOT}/ironbird/scenarios/zero.yaml`;
  const { calls } = parseTranscript(
    transcript(
      use('a', 'Bash', { command: 'ls .ironbird/runs' }),
      done('a', JSON.stringify({ passed: true, artifacts: run })),
      use('b', 'Bash', { command: 'npx ironbird scenario run ironbird/scenarios --target ios' }),
      done('b', `${JSON.stringify({ file: `${ROOT}/ironbird/scenarios/other.yaml`, passed: false, target: 'ios', artifacts: `${run}-x` })}\n${JSON.stringify({ file, passed: true, target: 'ios', artifacts: run })}\n`, true),
      use('c', 'mcp__ironbird__ironbird_screenshot', {}),
      done('c', [{ type: 'text', text: '{"target":"ios","path":"x.png"}' }, { type: 'image', source: {} }]),
      use('d', 'mcp__ironbird__ironbird_run_scenario', { path: 'ironbird/scenarios/zero.yaml' }),
      done('d', [{ type: 'text', text: JSON.stringify({ results: [{ file, passed: true, target: 'headless', artifacts: `${ROOT}/.ironbird/runs/h` }] }) }]),
    ),
  );

  it('parses CLI JSON lines, even from a failed exit, and the MCP tool\'s results; other calls report nothing', () => {
    expect(scenarioResultsOf(calls[0])).toEqual([]);
    expect(scenarioResultsOf(calls[1]).map((result) => result.passed)).toEqual([false, true]);
    expect(scenarioResultsOf(calls[3])).toEqual([{ file, passed: true, target: 'headless', artifacts: `${ROOT}/.ironbird/runs/h` }]);
  });

  it('finds the call whose reported artifacts equal the run folder exactly', () => {
    expect(reportingCall(calls, run, [ROOT])).toMatchObject({ call: { id: 'b' }, result: { file, target: 'ios', passed: true } });
    expect(reportingCall(calls, `${ROOT}/.ironbird/runs/2026-10-01T10-00-00-000Z-zero`, [ROOT])).toBeUndefined();
  });

  it('reads a capture\'s target from its result, its input, or --target, and needs ios after the position', () => {
    expect(captureTarget(calls[2])).toBe('ios');
    expect(captureTarget({ input: { command: 'npx ironbird step cart.clear --target headless' }, resultText: 'plain' })).toBe('headless');
    expect(iosCaptureAfter(calls, 3)).toBe(true);
    expect(iosCaptureAfter(calls, 4)).toBe(false);
    const headlessShot = parseTranscript(transcript(use('s', 'mcp__ironbird__ironbird_step', { command: 'cart.clear' }), done('s', '{"target":"headless"}'))).calls;
    expect(iosCaptureAfter(headlessShot, -1)).toBe(false);
  });
});

describe('untrackedWrites', () => {
  it('flags redirection, tee, and --output, but not /dev/null or descriptor merges', () => {
    const bash = (command) => ({ name: 'Bash', input: { command } });
    const calls = [bash('npm test 2>&1'), bash('npx vitest run >/dev/null 2>&1'), bash('git diff > fix.patch'), bash('git log --output=log.txt'), bash('npx ironbird state | tee s.json'), bash('npm test')];
    expect(untrackedWrites(calls).map((call) => call.input.command)).toEqual(['git diff > fix.patch', 'git log --output=log.txt', 'npx ironbird state | tee s.json']);
  });
});

describe('outOfFolderPaths with relative paths', () => {
  it('flags relative Bash paths that escape the session folder through .. segments, and not ones that stay inside', () => {
    const { calls } = parseTranscript(
      transcript(
        use('a', 'Bash', { command: 'cat ./../other-project/file' }),
        use('b', 'Bash', { command: 'cat src/../../../../template/file' }),
        use('c', 'Bash', { command: 'cat src/../src/x.ts' }),
        use('d', 'Bash', { command: 'npx ironbird screenshot --out=src/../../shot.png' }),
        use('e', 'Bash', { command: 'git diff main..feature -- src/core' }),
      ),
    );
    expect(outOfFolderPaths(calls, [ROOT], HOME)).toEqual([
      { index: 0, tool: 'Bash', path: path.resolve(ROOT, './../other-project/file') },
      { index: 1, tool: 'Bash', path: path.resolve(ROOT, 'src/../../../../template/file') },
      { index: 3, tool: 'Bash', path: path.resolve(ROOT, 'src/../../shot.png') },
    ]);
  });
});

describe('outOfFolderPaths', () => {
  it('flags file tools, search folders, absolute Glob patterns, run_scenario paths, and Bash words outside the session folder, and nothing inside it', () => {
    const { calls } = parseTranscript(
      transcript(
        use('a', 'Read', { file_path: 'src/core/checkout.ts' }),
        use('b', 'Read', { file_path: '/Users/dev/apps/ironbird/AGENTS.md' }),
        use('c', 'Bash', { command: 'npx vitest run ../../../template/src 2>/dev/null' }),
        use('d', 'Bash', { command: 'npx ironbird screenshot --out=~/Desktop/shot.png' }),
        use('e', 'mcp__ironbird__ironbird_run_scenario', { path: 'ironbird/scenarios' }),
        use('f', 'mcp__ironbird__ironbird_state', { path: 'order.totalCents' }),
        use('g', 'Bash', { command: 'curl http://127.0.0.1:4567/status' }),
        use('h', 'Grep', { pattern: 'totalCents', path: 'src' }),
        use('i', 'Grep', { pattern: 'plantRace', path: '/Users/dev/apps/ironbird/examples' }),
        use('j', 'Glob', { pattern: '/Users/dev/.ironbird-eval/sessions/2/project/src/**/*.ts' }),
        use('k', 'Glob', { pattern: 'src/**/*.test.ts' }),
      ),
    );
    expect(outOfFolderPaths(calls, [ROOT], HOME)).toEqual([
      { index: 1, tool: 'Read', path: '/Users/dev/apps/ironbird/AGENTS.md' },
      { index: 2, tool: 'Bash', path: path.resolve(ROOT, '../../../template/src') },
      { index: 3, tool: 'Bash', path: '/Users/dev/Desktop/shot.png' },
      { index: 8, tool: 'Grep', path: '/Users/dev/apps/ironbird/examples' },
      { index: 9, tool: 'Glob', path: '/Users/dev/.ironbird-eval/sessions/2/project/src' },
    ]);
  });
});

describe('stripHeredocs', () => {
  it('removes a quoted heredoc body and its terminator, keeps the operator line, and handles several heredocs', () => {
    const command = [
      "mkdir -p d && cat > d/a.ts <<'EOF'",
      "import { store } from '../store/store';",
      '// the store',
      'export const a = 1;',
      'EOF',
      '&& cat > d/b.ts <<EOF',
      "import { a } from '../a';",
      '// b',
      'EOF',
      'ls',
    ].join('\n');
    expect(stripHeredocs(command)).toBe(["mkdir -p d && cat > d/a.ts <<'EOF'", '&& cat > d/b.ts <<EOF', 'ls'].join('\n'));
  });

  it('accepts double-quoted and <<- delimiters, and a tab-indented terminator only for <<-', () => {
    expect(stripHeredocs('cat <<"END"\n../x\nEND\nls')).toBe('cat <<"END"\nls');
    expect(stripHeredocs('cat <<-EOF\n\t../x\n\tEOF\nls')).toBe('cat <<-EOF\nls');
    // Without the dash an indented line is body text, so the heredoc runs on.
    expect(stripHeredocs('cat <<EOF\n../x\n\tEOF\nls')).toBe('cat <<EOF');
  });

  it('strips an unterminated heredoc to the end of the command', () => {
    expect(stripHeredocs("cat > a.ts <<'EOF'\nimport '../x';\n// c")).toBe("cat > a.ts <<'EOF'");
  });

  it('strips two heredocs started on one line, in order', () => {
    expect(stripHeredocs('cat <<A <<B\n../a\nA\n../b\nB\nls')).toBe('cat <<A <<B\nls');
  });

  it('does not treat a here-string as a heredoc', () => {
    const command = 'cat <<< "../x"\nls /etc';
    expect(stripHeredocs(command)).toBe(command);
  });

  it('leaves a command without heredocs unchanged', () => {
    expect(stripHeredocs('ls ../x\ncat /etc/hosts')).toBe('ls ../x\ncat /etc/hosts');
  });
});

describe('outOfFolderPaths with heredocs', () => {
  const hits = (command) => outOfFolderPaths(parseTranscript(transcript(use('a', 'Bash', { command }))).calls, [ROOT], HOME);

  it('ignores import specifiers and comments in heredoc bodies (the proxy-1 shape)', () => {
    const command = [
      "mkdir -p d && cat > d/a.ts <<'EOF'",
      "import { store } from '../store/store';",
      '// comment',
      "export * from '../../shared';",
      'EOF',
      '&& cat > d/b.ts <<EOF',
      "import { a } from './a'; // ../nope",
      'EOF',
    ].join('\n');
    expect(hits(command)).toEqual([]);
  });

  it('still reports a path on the operator line', () => {
    expect(hits("cat > /etc/x <<'EOF'\nbody ../y\nEOF")).toEqual([{ index: 0, tool: 'Bash', path: '/etc/x' }]);
  });

  it('still reports a path after the terminator', () => {
    expect(hits('cat > a.ts <<EOF\n../in-body\nEOF\ncat /etc/hosts')).toEqual([{ index: 0, tool: 'Bash', path: '/etc/hosts' }]);
  });

  it('still reports a path in a here-string', () => {
    expect(hits('cat <<< ../x')).toEqual([{ index: 0, tool: 'Bash', path: path.resolve(ROOT, '../x') }]);
  });
});
