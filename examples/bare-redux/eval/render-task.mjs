#!/usr/bin/env node
// Writes the contract block in exercise/TASK.md from exercise/acceptance.yaml, or with --check exits 1
// when the block is out of date. Run it after changing acceptance.yaml, then regenerate the copy in
// integration-exercise/ with `pnpm --filter @ironbird-examples/bare-redux make:exercise`.
//
//   node examples/bare-redux/eval/render-task.mjs [--check]
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseScenario } from '@ironbird/cli/runner';
import { acceptanceContract, contractBlock, replaceContractBlock } from './lib/contract.mjs';
import { ACCEPTANCE, TASK_SHEET } from './lib/paths.mjs';

const { values } = parseArgs({ options: { check: { type: 'boolean' } } });
const contract = acceptanceContract(parseScenario(await readFile(ACCEPTANCE, 'utf8'), ACCEPTANCE));
const current = await readFile(TASK_SHEET, 'utf8');
const next = replaceContractBlock(current, contractBlock(contract));
if (values.check) {
  if (next !== current) {
    process.stderr.write('exercise/TASK.md is out of date; run node examples/bare-redux/eval/render-task.mjs, then pnpm --filter @ironbird-examples/bare-redux make:exercise\n');
    process.exitCode = 1;
  }
} else {
  await writeFile(TASK_SHEET, next);
}
