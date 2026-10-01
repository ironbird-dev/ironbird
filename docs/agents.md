# ironbird: Agent setup

| | |
|---|---|
| Status | Draft |
| Last updated | 2026-09-29 |
| Related | [cli.md](cli.md) (`mcp`, `agent setup`, "MCP tools") · [architecture.md](architecture.md) |

ironbird gives a coding agent two things: an MCP server, `ironbird mcp`, whose tools drive your app through its declared commands, and a skill that teaches the agent a loop for using them. The loop: reproduce a bug headlessly, pin it down as a scenario, fix it, check it on a device, and report with evidence. This page sets both up.

## Set up

In the project root, with `@ironbird/cli` installed as a dev dependency and the app integrated (see [architecture.md](architecture.md#5-integrating-an-app)), run:

```sh
npx ironbird agent setup
```

It does two things and prints what it did as `{ skill: { dir, files }, mcp: { file, updated } }`:

- Copies the skill into `.claude/skills/ironbird/`: `SKILL.md` and `references/scenarios.md`. Other files in that folder are left alone.
- Adds an `ironbird` entry to `mcpServers` in `.mcp.json`, creating the file if needed. Other servers and keys are kept.

```json
{
  "mcpServers": {
    "ironbird": { "command": "npx", "args": ["ironbird", "mcp"] }
  }
}
```

Commit both, so every contributor and every agent session gets the same setup. Run the command again after upgrading `@ironbird/cli`: the skill is versioned with the CLI, and a rerun brings it up to date. If `.mcp.json` exists but isn't a JSON object, or its `mcpServers` isn't one, the command fails with `INVALID_CONFIG` and changes nothing.

Install `@ironbird/cli` locally, so `npx ironbird` runs the project's version rather than downloading one. Claude Code picks up the skill and the server at the start of the next session, and asks once before trusting a project's `.mcp.json` servers.

## What the tools need

- **A running daemon.** Start it in the project root and leave it running: `npx ironbird serve`. The MCP server doesn't start it, but finds it on every tool call, so the order you start them in doesn't matter and restarting the daemon needs no agent restart. Until a daemon answers, every tool fails with `NO_TARGET` and a message saying to run `ironbird serve`; the skill tells the agent to start it.
- **For device checks, Metro and the app.** The app runs on a simulator or device with the bridge started, so it appears as a target such as `ios` in `npx ironbird status`. Screenshots use `xcrun simctl` or `adb` on the same machine as the daemon and the MCP server.
- **A token, for a daemon bound beyond localhost.** Put it in `IRONBIRD_TOKEN` in the agent's environment.

The headless target needs only the daemon. It is where agents should do most of their work: it is fast and deterministic, and it has clock and fake controls that a device lacks.

## The loop

The skill ([`SKILL.md`](../packages/cli/skills/ironbird/SKILL.md)) teaches six steps, each with its MCP tool and CLI equivalent:

1. **Orient:** `ironbird_status`, then `ironbird_describe` for commands, fakes, and capabilities.
2. **Reproduce headlessly:** drive commands, fake controls, and clock advances; read state, events, and fake calls.
3. **Pin it down as a scenario:** a YAML file under `ironbird/scenarios/` that fails before the fix.
4. **Fix:** change the code, `ironbird_reload`, and run the scenario until it passes; then the whole folder and the project's tests.
5. **Check on a device:** `ironbird_reload` the device target, run the same scenario on it, and take a screenshot.
6. **Report with evidence:** every "verified" quotes a passing run's `passed`, target, and artifacts path, and a check that could not run is reported as not done.

The skill is app-agnostic. It knows the tools and the loop, and learns your app from `ironbird_describe`.

## Other agents

The skill is in the Agent Skills format, so any agent that reads that format can use it. Point `--skills-dir` at the folder your agent reads skills from; `.mcp.json` is updated either way:

```sh
npx ironbird agent setup --skills-dir <your agent's skills folder>
```

For an agent that keeps MCP servers in its own configuration, register a stdio server that runs `npx ironbird mcp` in the project root, adding `--daemon <url>` if the daemon can't be found from there. An agent without MCP can follow the same skill through its CLI column: every tool has a CLI command that prints the same JSON.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every tool fails with `NO_TARGET`, "Daemon unreachable" | No daemon; run `npx ironbird serve` in the project root |
| `ironbird_step` or `ironbird_screenshot` fails with `NO_TARGET` | No app connected; start Metro and the app, then check `npx ironbird status` |
| `AMBIGUOUS_DEVICE` from a screenshot | Several simulators are booted; set `devices.ios` in the config or pass `device` |
| `ironbird_step` fails with `SCREENSHOT_FAILED` and a second note saying the command was already applied | The command ran and only the capture failed; don't retry the step, read state with `ironbird_state` |
| A headless check still shows the old behavior after an edit | `reset` re-runs the code loaded earlier; call `ironbird_reload` |
| `UNAUTHORIZED` | The daemon has a token; set `IRONBIRD_TOKEN` for the agent |
