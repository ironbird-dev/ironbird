---
"@ironbird/cli": patch
---

`scenario run` and `ironbird_run_scenario` no longer report a scenario path they may not read as missing. A permission or sandbox failure (`EACCES`, `EPERM`) is still `INVALID_SCENARIO`, now with the message `Cannot read <file>: <system error>`; only `ENOENT` and `ENOTDIR` give `No such file or directory`.
