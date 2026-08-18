# @davymassoneto/pi-subagent

Pi9 `@pi9/subagent@0.12.0` plus a thin `subagent_*` facade for `gentle-pi@2.2.0`.

Keeps the Pi9 runtime: recursion, generations, tree, spawn/join/inspect/steer/cancel/resume/remove, `/subagents`.

Adds YAML-list frontmatter, cwd `agents/` + `subagents/` discovery, and parent-only `subagent_run` / status / result tools. Does not copy Joker persistence or history UI.

Upstream: https://github.com/Chase-C/pi9/tree/subagent-v0.12.0/packages/subagent

Install (do not keep `@pi9/subagent` installed at the same time):

```
pi uninstall npm:@pi9/subagent
pi install git:github.com/DavyMassoneto/pi-subagent
```
