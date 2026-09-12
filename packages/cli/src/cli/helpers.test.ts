import { describe, expect, it } from 'vitest';
import { UsageError, parseDuration } from './durations';
import { exitCodeForError, exitCodeForStep } from './exit-codes';
import { createOutput } from './output';
import { parseJsonOrString, parsePayload } from './values';

describe('parseDuration', () => {
  it('accepts ms, s, m suffixes and bare milliseconds', () => {
    expect(parseDuration('250')).toBe(250);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('2s')).toBe(2_000);
    expect(parseDuration('1.5s')).toBe(1_500);
    expect(parseDuration('3m')).toBe(180_000);
  });

  it('rejects anything else with a UsageError', () => {
    for (const bad of ['', 'abc', '2h', '-5', '1 s']) expect(() => parseDuration(bad)).toThrow(UsageError);
  });
});

describe('values', () => {
  it('parses payloads as JSON and treats an omitted payload as {}', () => {
    expect(parsePayload(undefined)).toEqual({});
    expect(parsePayload('{"sku":"cut-45","qty":1}')).toEqual({ sku: 'cut-45', qty: 1 });
    expect(() => parsePayload('{oops')).toThrow(UsageError);
  });

  it('parses condition values as JSON when valid and strings otherwise', () => {
    expect(parseJsonOrString('0')).toBe(0);
    expect(parseJsonOrString('"0"')).toBe('0');
    expect(parseJsonOrString('true')).toBe(true);
    expect(parseJsonOrString('awaitingServerEcho')).toBe('awaitingServerEcho');
    expect(parseJsonOrString('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('exit codes', () => {
  it('maps error codes to the documented exit codes', () => {
    expect(exitCodeForError('INVALID_PAYLOAD')).toBe(1);
    expect(exitCodeForError('DISPATCH_FAILED')).toBe(1);
    expect(exitCodeForError('INTERNAL')).toBe(1);
    expect(exitCodeForError('AMBIGUOUS_TARGET')).toBe(2);
    expect(exitCodeForError('HEADLESS_LOAD_FAILED')).toBe(2);
    expect(exitCodeForError('INVALID_CONFIG')).toBe(2);
    expect(exitCodeForError('UNAUTHORIZED')).toBe(2);
    expect(exitCodeForError('APP_MISMATCH')).toBe(2);
    expect(exitCodeForError('WAIT_TIMEOUT')).toBe(4);
    expect(exitCodeForError('NO_TARGET')).toBe(5);
  });

  it('exits 3 only for applied-but-unsettled steps', () => {
    const base = { idle: false, quiescent: false, waitedMs: 0, pending: [] };
    expect(exitCodeForStep({ settle: { ...base, idle: true } })).toBe(0);
    expect(exitCodeForStep({ settle: { ...base, quiescent: true } })).toBe(0);
    expect(exitCodeForStep({ settle: base })).toBe(3);
    expect(exitCodeForStep({ settle: null })).toBe(0);
  });
});

describe('createOutput', () => {
  it('prints single-line JSON in json mode, including errors under an error key', () => {
    const lines: string[] = [];
    const output = createOutput({ json: true, write: (text) => lines.push(text) });
    output.result({ rev: 1, state: { a: 1 } });
    output.error({ code: 'NO_TARGET', message: 'none', details: { available: [] } });
    expect(lines).toEqual(['{"rev":1,"state":{"a":1}}\n', '{"error":{"code":"NO_TARGET","message":"none","details":{"available":[]}}}\n']);
  });

  it('prints readable text otherwise', () => {
    const lines: string[] = [];
    const output = createOutput({ json: false, write: (text) => lines.push(text) });
    output.result({ rev: 1 });
    output.error({ code: 'WAIT_TIMEOUT', message: 'timed out', details: { path: 'a' } });
    expect(lines[0]).toBe('{\n  "rev": 1\n}\n');
    expect(lines[1]).toBe('error WAIT_TIMEOUT: timed out\n  {\n    "path": "a"\n  }\n');
  });
});
