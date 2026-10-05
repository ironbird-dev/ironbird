---
"@ironbird/cli": patch
---
`/v1/stream` sends a `state` frame with the target's current revision as soon as the stream's state subscription is live, after the event backlog. A client that reads state after that frame misses no later change; `watch` starts this way. The frame is additive, so the protocol version stays 1.
