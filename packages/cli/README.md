# @ironbird/cli

The `ironbird` daemon and command line for [ironbird](https://github.com/ironbird-dev/ironbird). It loads your app's headless entry in Node, accepts development builds over the bridge, and gives agents and people the same commands: `send`, `state`, `wait`, `fake`, `clock`, `scenario run`, `step` with screenshots, `snapshot`, `watch`, and an MCP server.

```sh
npm install --save-dev @ironbird/cli
npx ironbird doctor          # checks Node, the config, the headless entry, the ports, .gitignore, and package versions
npx ironbird serve           # the daemon, in the foreground
npx ironbird commands
npx ironbird agent setup     # the MCP server and the agent skill for Claude Code
```

Node 22 or later. The unscoped `ironbird` package exposes the same binary, so `npx ironbird` also works without a local install.

- [Getting started](https://github.com/ironbird-dev/ironbird/blob/main/docs/guides/getting-started.md)
- [CLI reference](https://github.com/ironbird-dev/ironbird/blob/main/docs/cli.md)
- [Agent setup](https://github.com/ironbird-dev/ironbird/blob/main/docs/agents.md)

MIT licensed.
