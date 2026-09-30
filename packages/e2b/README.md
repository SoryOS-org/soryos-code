---
description: "The e2b group map: one deployment-chosen remote E2B sandbox per composition, for users and maintainers navigating the group."
kind: "package-group"
---

# e2b/ — E2B remote sandbox connection

English | [中文](README.zh.md)

## Summary

The e2b group provides one deployment-chosen remote sandbox for compositions that execute inside E2B isolated VMs while the Harness, model transport, and Session storage stay on the host. `e2b` owns the sandbox lifecycle — create, adopt by ID, pause, resume, destroy, and workspace initialization — serialized behind one queue, and consumers read the sandbox handle from `ctx.e2b`. `fs-e2b` provides `ctx.fs` over the sandbox workspace, and `subprocess-e2b` provides `ctx.subprocess` for commands and terminals inside the sandbox, so files and processes share one remote world. Choose it when remote isolation matters; host sandbox backends already confine local work without a remote machine.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | Service |
|---|---|---|
| [`e2b`](e2b/README.md) | Remote sandbox lifecycle: create, adopt, pause, resume, destroy, and workspace setup | `ctx.e2b` |
| [`fs-e2b`](fs-e2b/README.md) | Filesystem provider over the sandbox workspace | `ctx.fs` |
| [`subprocess-e2b`](subprocess-e2b/README.md) | Subprocess provider: commands and terminals inside the sandbox | `ctx.subprocess` |

-----

<a id="related-documentation"></a>
## Related documentation

- [E2B subsystem](../../docs/subsystems/e2b.md) — configuration, lifecycle semantics, and the generated service API.
- [Provider removal decision](../../.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.md) — why the earlier E2B provider family was removed and the conditions a reintroduction must satisfy.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
