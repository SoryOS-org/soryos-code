---
description: "Remote filesystem semantics for consumers sharing files with processes in the E2B sandbox."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-e2b

English | [中文](README.zh.md)

## Summary

`dsh-fs-e2b` provides `ctx.fs` over the E2B sandbox owned by [`dsh-e2b`](../e2b/README.md). File tools read and mutate the same files that sandbox processes see, in one POSIX namespace. Path resolution follows symbolic links to one identity, versions come from sandbox metadata, and writes and edits run one at a time per target with the filesystem error codes the local provider reports.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider with [`dsh-e2b`](../e2b/README.md), which it injects as `ctx.e2b`. Relative paths resolve against the configured `cwd`, defaulting to the connection's workspace directory. `diffBasisMaxBytes` (default 10 MiB) bounds how much prior content an overwrite reads to build its contextual `before`; a larger or binary file still writes with `before: null`.

`processPath()` names the file in the sandbox namespace that sandbox processes open; it grants no host-side access. `processPathFromHostPath()` returns `undefined`: host executables and bootstrap files are not visible inside the sandbox, so consumers that need them must place them in the sandbox explicitly. `resolve()` reports missing targets, non-directories, and permission failures with the same `FsErrorCode` values the local provider uses, and an aborted signal rejects with `FS_ABORTED` before or between SDK calls.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`resolve()` follows symbolic links, so aliases share one target identity; resolution gives up after 40 link hops, the POSIX per-lookup limit. Version tokens come from the sandbox entry's modification time, size, and mode. Writes and edits hold a per-target FIFO lock across read, stale-version guard, and publish, so concurrent mutations order deterministically: one wins and the rest reject as stale. Overwrite diffs read the prior bytes only when the file is textual and within the diff-basis limit; text preserves the file's line endings, and streams decode incrementally with the shared UTF-8 and binary rules.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — shared operations and error meanings.
- [E2B subsystem](../../../docs/subsystems/e2b.md) — connection lifecycle and workspace initialization.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through existing filesystem consumers, which present sandbox paths and file contents while owning every tool and prompt.

#### KV Cache effect

This provider contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Filesystem watching is unsupported: the provider keeps no `watch()` override, so the base `FS_IO_ERROR` rejection applies. Reads and consumer-owned manual refresh remain available.
- Host files are not shared: `processPathFromHostPath()` returns `undefined`, and file URLs are sandbox coordinates, not host handles or Web download links.
- Version tokens come from sandbox metadata, so a rewrite in the same millisecond with the same size and mode can read as unchanged and pass a stale-version guard.
- The provider is covered by fixture-backed unit tests; live-sandbox end-to-end coverage runs against a real E2B deployment with a key.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. The filesystem seam and the E2B connection own the observable obligations; this provider adds no independently observed state relation beyond its fixture-replayed SDK calls.

</details>
