import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer, type McpServerOptions } from './server';

/**
 * Serves the ironbird tools over this process's stdin and stdout until stdin ends or the process
 * is asked to stop. Only MCP messages reach stdout (docs/cli.md, `mcp`).
 */
export async function runMcpStdio(options: McpServerOptions): Promise<void> {
  const handle = await serveStdio(() => createMcpServer(options));
  await new Promise<void>((resolve) => {
    const done = (): void => {
      process.stdin.off('end', done);
      process.stdin.off('close', done);
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.stdin.once('end', done);
    process.stdin.once('close', done);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await handle.close();
}
