import { createRequire } from 'node:module';
import { buildProgram } from './cli/program';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const { run } = buildProgram({
  cwd: process.cwd(),
  env: process.env,
  isTTY: process.stdout.isTTY === true,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  version,
});

process.exitCode = await run(process.argv.slice(2));
