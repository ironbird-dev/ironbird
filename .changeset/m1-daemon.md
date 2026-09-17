---
"@ironbird/cli": patch
---

Remote mode in the daemon. `ironbird serve` accepts bridge connections on `bridge.port` (default 4568) on the same host as the HTTP API, with the handshake, target ids, heartbeat, and disconnect semantics from docs/protocol.md §3; connected apps appear in `status` and take every operation the headless target takes except the clock and `reset`. New commands: `screenshot` and `step` capture through `xcrun simctl` and `adb`. `serve` runs `adb reverse` for connected Android devices and records `bridgeUrl` in `daemon.json`. The SSE stream carries `target` frames and ends with `TARGET_DISCONNECTED` when its target disconnects. Config gains `boot.timeoutMs`. `@ironbird/cli` now exports `DaemonTarget`, `createOperationQueue`, and the remote-target, bridge-server, device, and screenshot modules.
