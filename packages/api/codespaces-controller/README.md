---
description: "Codespaces environment Remote namespace: configuration, lifecycle, repository/branch/machine pickers, and the GitHub authorization flow bridge"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-codespaces-controller

English | [中文](README.zh.md)

## Summary

`dsh-api-codespaces-controller` provides the Codespaces environment Remote namespace (`ctx.remote.codespaces`): the browser-facing API surface over the Codespaces lifecycle. It exposes configuration helpers (repository/branch/machine pickers), environment configuration, connect/disconnect/reconnect/stop/remove operations, and the GitHub authorization flow bridge. Every operation is server-side; the GitHub token never crosses this namespace to the browser.

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

This is a **host-only** package; compose it in the host half of a `dsh` profile. The controller registers with Typert to expose a `ctx.remote.codespaces` namespace that the client can call. The browser UI uses these methods to drive the Codespaces configuration and connection flow.

### Configuration methods

```typescript
// List repositories the user can create codespaces in
const repos = await ctx.remote.codespaces.listRepositories()

// List branches of a repository
const branches = await ctx.remote.codespaces.listBranches('owner/name')

// List available machine types for a repository
const machines = await ctx.remote.codespaces.listMachines('owner/name')
```

### Environment lifecycle methods

```typescript
// Configure Codespaces for a workspace
const config = await ctx.remote.codespaces.configure({
  workspaceId: 'workspace-uuid',
  config: {
    repository: 'owner/name',
    branch: 'main',
    machine: 'basicLinux32gb',
  },
})

// Get the current environment status for a workspace
const status = await ctx.remote.codespaces.getStatus({ workspaceId: 'workspace-uuid' })
// status.lifecycle - current connection lifecycle
// status.configured - whether Codespaces is configured
// status.repository, status.branch, status.machine - stored config
// status.codespaceName, status.workspaceUrl - provisioned identity
// status.codespaceState - GitHub-reported codespace state
// status.authorization - GitHub auth facts

// Connect the workspace to its Codespace environment
const result = await ctx.remote.codespaces.connect({ workspaceId: 'workspace-uuid' })
// result.url - the forwarded workspace URL
// result.lifecycle - the resulting lifecycle state

// Reconnect after network loss
const reconnected = await ctx.remote.codespaces.reconnect({ workspaceId: 'workspace-uuid' })

// Disconnect (closes SSH connection, keeps codespace running)
await ctx.remote.codespaces.disconnect({ workspaceId: 'workspace-uuid' })

// Stop the codespace (filesystem survives, processes do not)
await ctx.remote.codespaces.stop({ workspaceId: 'workspace-uuid' })

// Delete the codespace and clear stored state (destructive and irreversible)
await ctx.remote.codespaces.remove({ workspaceId: 'workspace-uuid' })
```

### GitHub authorization methods

```typescript
// Get current GitHub authorization facts
const auth = await ctx.remote.codespaces.getAuthorization()
// auth.configured - whether GitHub is configured
// auth.methods - available authorization methods

// Begin GitHub authorization flow
const stream = ctx.remote.codespaces.followAuthorization({ method: 'device' }, signal)
// Stream yields: notice, prompt, or settlement frames
for await (const frame of stream) {
  if (frame.kind === 'notice') {
    // Show notice to user
    console.log(frame.message)
  } else if (frame.kind === 'prompt') {
    // Show prompt to user, collect answer
    const answer = await collectAnswer(frame.message, { secret: frame.secret })
    await ctx.remote.codespaces.answerAuthorization({ promptId: frame.promptId, answer })
  } else if (frame.kind === 'settlement') {
    // Authorization complete
    if (frame.authorized) console.log('Authorized!')
    else console.log('Authorization cancelled or failed')
  }
}

// Cancel the running authorization attempt
await ctx.remote.codespaces.cancelAuthorization()
```

### TypeScript client import

```typescript
import { codespacesClient } from '@deepseek-ai/dsh-api-codespaces-controller/remote'

// Use the client to call remote methods
const repos = await codespacesClient.listRepositories()
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The controller extends `TypertRemoteService` and exposes methods via the `@Remote` decorator. It acts as a **thin bridge** between the browser client and the host services:

### Service dependencies

- `ctx.github` - GitHub token resolution and authorization
- `ctx.codespaces` - Codespaces API service
- `ctx.codespacesRegistry` - Durable state storage
- `ctx.codespacesConnection` - Connection lifecycle service

### Method categories

#### 1. Picker methods (pass-through to codespaces service)
- `listRepositories()` → `ctx.codespaces.listRepositories()`
- `listBranches(repository)` → `ctx.codespaces.listBranches(repository)`
- `listMachines(repository)` → `ctx.codespaces.listMachines(repository)`

#### 2. Configuration method
- `configure(request)` - Validates config against GitHub, saves to registry
  - Validates repository exists
  - Validates branch exists (defaults to repository default branch)
  - Constructs `CodespacesWorkspaceState`
  - Saves to `ctx.codespacesRegistry`

#### 3. Status method
- `getStatus(request)` - Reads registry and GitHub state
  - Reads stored state from registry
  - Gets GitHub authorization facts
  - Reads current codespace state from GitHub (if codespaceName exists)
  - Returns comprehensive status with lifecycle, config, and auth

#### 4. Lifecycle methods (pass-through to connection service)
- `connect(request)` → `ctx.codespacesConnection.connect(workspaceId)`
- `reconnect(request)` → `ctx.codespacesConnection.reconnect(workspaceId)`
- `disconnect(request)` → `ctx.codespacesConnection.disconnect()`
- `stop(request)` → `ctx.codespacesConnection.stopCodespace(workspaceId)`
- `remove(request)` → `ctx.codespacesConnection.deleteEnvironment(workspaceId)`

#### 5. Authorization methods
- `getAuthorization()` - Gets GitHub auth facts via `ctx.github.describe()`
- `followAuthorization(request, signal)` - Streams auth flow via `AuthorizationBridge`
- `answerAuthorization(request)` - Answers pending prompt
- `cancelAuthorization()` - Cancels running auth attempt

### Authorization bridge

The `AuthorizationBridge` class implements `AuthorizationInteraction` to bridge between Typert streaming and the GitHub authorization flow:
- Collects notices from the auth flow
- Collects prompts and returns promises for answers
- `drainNotices()` - Returns accumulated notices
- `pendingPrompt()` - Returns oldest unanswered prompt
- `answer(promptId, answer)` - Resolves the prompt's promise

The `followAuthorization` method:
1. Creates a new `AuthorizationBridge`
2. Starts the auth flow via `ctx.github.beginAuthorization()`
3. Yields frames for notices, prompts, and settlement
4. Cleans up the bridge on completion or error

### Remote namespace

The controller registers with Typert to create `ctx.remote.codespaces` namespace. The client imports from `@deepseek-ai/dsh-api-codespaces-controller/remote` to access the generated client.

### Generated artifacts

- `lib/typert.remote-client.js` - Generated TypeScript client for browser
- `lib/typert.remote-client.d.ts` - TypeScript types for the client

### Token security

The GitHub token is resolved server-side and never exposed to the browser. Authorization flows use a bridge pattern where prompts are sent to the browser and answers are returned to the server.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Codespaces connection package](../../codespaces/codespaces-connection/README.md) — the connection lifecycle service.
- [Codespaces registry package](../../codespaces/codespaces-registry/README.md) — the durable state service.
- [Codespaces package](../../codespaces/codespaces/README.md) — the underlying GitHub API service.
- [Typert protocol package](../../typert/protocol/README.md) — the Remote RPC protocol.
- [GitHub auth package](../../github-auth/README.md) — the authorization service.

<a id="model-experience"></a>
## Model Experience

None, as this package provides the Remote API surface for Codespaces configuration only.

#### KV Cache effect

None; this package is pure API infrastructure.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- All methods run server-side; there is no client-side caching.
- The authorization flow is interactive and requires user input in the browser.
- Only one authorization attempt can run at a time; concurrent attempts are not supported.
- Prompts are returned in the order they are emitted; the browser must answer them in that order.
- No automatic retry on transient failures; the client must handle errors and retry.

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. The Typert protocol and the underlying services enforce correctness; this controller owns only the API surface and authorization bridging.

</details>
