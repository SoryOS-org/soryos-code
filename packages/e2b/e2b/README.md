---
description: "The E2B remote sandbox connection for operators and agents configuring one sandbox's creation, adoption, pause, resume, destruction, and workspace directory."
kind: "package-reference"
---

# @deepseek-ai/dsh-e2b

English | [中文](README.zh.md)

## Summary

`dsh-e2b` owns one remote E2B sandbox for a composition: create it, adopt an existing sandbox by ID, pause and resume it, destroy it, and initialize its workspace directory. Lifecycle calls run one at a time, so `status()` reports one state — `absent`, `starting`, `ready`, `paused`, or `failed` — together with the last failure message. The deployment API key comes from configuration or an environment variable, and every control-plane call carries the configured deadline. Choose it when work should run inside an E2B sandbox while the Harness, model transport, and Session storage stay on the host.

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

Mount `dsh-e2b` when a composition should own one deployment-chosen E2B sandbox and drive it through `ctx.e2b`; consumers read the sandbox handle from `ctx.e2b.sandbox`.

### When to use it

Choose it when execution belongs in E2B's isolated remote VM while files, model transport, and session records stay on the host. The connection owns at most one sandbox: a second `create` or `connect` while one is held is refused. Skip it for compositions that execute only on the host; the local subprocess providers and the host [sandbox](../../../docs/subsystems/sandbox.md) backends confine that work without a remote VM.

### Set up the connection

Load the package with a composition entry; the required field is the absolute directory `initWorkspace` creates inside the sandbox.

```yaml
- name: '@deepseek-ai/dsh-e2b'
  config:
    workspace: /home/user/project
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | E2B API key literal for every control-plane call; overrides the credential store |
| `apiKeyEnv` | `E2B_API_KEY` | Credential reference the key is resolved under, through `ctx.credentials` and then the process environment |
| `domain` | SDK default | E2B control-plane domain |
| `template` | SDK default | Sandbox template name or ID passed to every create |
| `timeoutMs` | SDK default | Sandbox lifetime, 1000–86,400,000 ms; also sent to connect and resume |
| `requestTimeoutMs` | SDK default | Deadline for each control-plane call, 1000–2,147,483,647 ms |
| `workspace` | required | Absolute sandbox directory created by `initWorkspace` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-e2b) is the exhaustive source for every accepted field. A missing key fails the first lifecycle call with the `apiKeyEnv` reference named; no request runs when the plugin loads or disposes.

### Configure the connection from settings

Every field but `workspace` is volatile, so a deployment that composes the [E2B settings card](../../../packages/client/ui-settings-e2b/README.md) can set the key, the reference naming it, the template, and both deadlines from the Plugins page instead of a profile file. `workspace` stays ordinary: it is deployment identity, owned by the preset.

The key never rides a settings response. `apiKey` is a `role('secret')` ordinary field, so the settings service excludes it from the form and redacts it wherever it appears; the card writes the key through the credentials domain, addressed by the `apiKeyEnv` reference. Each control-plane call re-resolves the key in that order — the `apiKey` literal, then `ctx.credentials.resolve(apiKeyEnv)`, then the process environment — which is what makes a key written in the card reach the next `create` without a restart.

```yaml
# cordis.yml, with the key left to the credentials store
- id: e2b
  name: '@deepseek-ai/dsh-e2b'
  config:
    apiKeyEnv: E2B_API_KEY
    workspace: /home/user
```

### Drive the lifecycle

| Operation | What it does |
|---|---|
| `create` | Creates a sandbox and owns it until `destroy` |
| `connect` | Adopts an existing sandbox by ID; a paused sandbox resumes to running |
| `pause` | Pauses the owned sandbox, keeping its filesystem and memory |
| `resume` | Reconnects and resumes the owned paused sandbox |
| `destroy` | Kills the owned sandbox and releases it |
| `initWorkspace` | Creates the configured workspace directory in a running sandbox |

Every operation enters one queue, so concurrent callers never interleave transitions. A rejected operation keeps ownership unchanged and records its message in `status()`; a later success clears it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the connection realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **One serialized owner.** A single promise queue runs create, connect, pause, resume, destroy, and workspace initialization strictly in order, accepting each outcome before the next operation starts. The local state machine moves `absent → starting → ready → paused` with `failed` recording the last operation's message, cleared by the next success.
- **Key and deadline resolution.** Each call resolves `apiKey` (falling back to the `apiKeyEnv` environment variable) and builds fresh connection options carrying the resolved key, configured domain, `requestTimeoutMs`, and the caller's `AbortSignal`, so no secret is cached beyond the call and cancellation reaches the SDK request.
- **Ambiguous cancellation.** An aborted create can abandon a sandbox E2B already started; the connection records the failure, never reconnects to confirm it, and the abandoned sandbox expires with the `timeoutMs` sent on create.
- **Disposal detaches.** Disposal clears the local handle and state without an API call, so application teardown never blocks on the network and the remote sandbox lives only until its bounded lifetime ends.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `E2bConnection`, config schema, status types, `Context.e2b` declaration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [E2B subsystem](../../../docs/subsystems/e2b.md) — configuration, lifecycle semantics, and the generated service API.
- [E2B group map](../README.md) — the packages under `packages/e2b/`.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-e2b) — every accepted config field and its source declaration.
- [Provider removal decision](../../../.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.md) — why the earlier E2B provider family was removed and the conditions a future provider must satisfy.

-----

<a id="model-experience"></a>
## Model Experience

None, as API keys, sandbox identifiers, and lifecycle transitions are private deployment details and consumers own every model-visible operation.

#### KV Cache effect

This connection contributes no request-prefix content; a consumer that renders sandbox state or results in a prompt owns its own token effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the connection's current scope; they are package constraints, not a task backlog.

- **Lifecycle only** — the connection owns no execution capability of its own; `dsh-fs-e2b` and `dsh-subprocess-e2b` are the providers that consume it, and a composition can still read `ctx.e2b.sandbox` directly.
- **The settings card is optional wiring** — the `e2b` namespace exists in the settings service whether or not the Web client page is composed, and a deployment that configures only a profile never mounts the card.
- **One sandbox per composition** — parallel sandboxes require separate compositions because a held connection refuses a second owner.
- **No reconnect or replay** — a lost or aborted control-plane call is recorded as a failure and never retried; an aborted create can leave an unreachable sandbox that only its bounded lifetime removes.
- **Local status only** — `status()` reads local memory and never probes E2B, so remote drift (manual deletion or E2B-side expiry) surfaces on the next operation instead of in status.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. One serialized owner records every lifecycle transition locally, and the E2B control plane is the only external observer; the package owns no second independent observation for a companion to compare. The [provider removal decision](../../../.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.md) records the retention, cancellation, and reconnect conditions this design must keep satisfying.

</details>
