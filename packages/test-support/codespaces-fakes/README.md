---
description: "Fake GitHub Codespaces API and fake Harness runtime for integration tests; mocks are test-only and never production implementations"
kind: "package-reference"
---

# @deepseek-ai/dsh-codespaces-fakes

English | [中文](README.zh.md)

## Summary

`dsh-codespaces-fakes` provides test-only fake implementations for the GitHub Codespaces API and the remote Harness runtime. These fakes enable integration testing of the Codespaces feature without requiring a GitHub account, a real codespace, or SSH connectivity. They are **explicitly test-only** and must never be used in production code.

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

Import and use the fake servers in integration tests:

```typescript
import { FakeGitHubApi, FakeHarnessRuntime } from '@deepseek-ai/dsh-codespaces-fakes'

// Start the fake GitHub API
const fakeGitHub = await FakeGitHubApi.start()
// fakeGitHub.baseUrl - the URL to configure as config.apiBase

// Start the fake Harness runtime
const fakeHarness = await FakeHarnessRuntime.start()
// fakeHarness.baseUrl - the URL the codespace will forward to

// Run your test...

// Clean up
await fakeHarness.stop()
await fakeGitHub.stop()
```

### Configuring the Codespaces service for testing

```typescript
import { CodespaceService } from '@deepseek-ai/dsh-codespaces'

const fakeGitHub = await FakeGitHubApi.start()
const ctx = new Context()

// Configure the codespaces service to use the fake API
await ctx.plugin(CodespaceService, { apiBase: fakeGitHub.baseUrl })

// Or via composition
await ctx.plugin(CodespaceService, { apiBase: fakeGitHub.baseUrl })
```

### Using with the connection service

The fake GitHub API responds to the same endpoints as the real GitHub REST API for Codespaces:

```typescript
// The fake supports:
// - GET /user/repos - list repositories
// - GET /repos/{owner}/{name} - get repository
// - GET /repos/{owner}/{name}/branches - list branches
// - GET /repos/{owner}/{name}/branches/{branch} - get branch
// - GET /repos/{owner}/{name}/codespaces/machines - list machines
// - GET /user/codespaces - list codespaces
// - POST /user/codespaces - create codespace
// - GET /user/codespaces/{name} - get codespace
// - POST /user/codespaces/{name}/start - start codespace
// - POST /user/codespaces/{name}/stop - stop codespace
// - DELETE /user/codespaces/{name} - delete codespace
// - GET /repos/{owner}/{name}/contents/.devcontainer/devcontainer.json - get devcontainer
// - PUT /repos/{owner}/{name}/contents/.devcontainer/devcontainer.json - write devcontainer
```

### Inspecting requests

The fake API logs all requests for verification:

```typescript
const fakeGitHub = await FakeGitHubApi.start()

// Run your test code...

// Verify the requests made
const requests = fakeGitHub.requests
// [{ method: 'GET', path: '/user/repos' }, ...]

// Verify codespace states observed
const state = fakeGitHub.stateOf('fake-codespace-1')
// 'provisioning' | 'available' | 'shutdown' | etc.
```

### Using with the fake Harness runtime

The fake Harness runtime responds to endpoints used by the codespaces connection:

```typescript
// The fake supports:
// - GET /health - health check
// - POST /session - create session
// - POST /fs/read - read file
// - POST /terminal - execute terminal command
// - GET /events - SSE events
```

Use it to test the SSH bootstrap and harness launch flow:

```typescript
const fakeHarness = await FakeHarnessRuntime.start()

// The codespace connection will try to connect to this URL
// after SSH bootstrap and port forwarding resolution
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This package provides **two fake servers** for testing:

### 1. FakeGitHubApi

A lightweight HTTP server that mimics the GitHub Codespaces REST API:

**Constructor and lifecycle:**
- `static async start()` - Creates server, starts listening on ephemeral port
- `get baseUrl()` - Returns `http://127.0.0.1:<port>`
- `get requests()` - Returns all requests received (for verification)
- `stateOf(name)` - Returns the last observed state for a codespace
- `async stop()` - Stops the server

**Internal state:**
- `codespaces: Map<string, FakeCodespace>` - Stores created codespaces
- `nextId: number` - Counter for generating codespace IDs
- `requestLog: array` - Records all requests for verification
- `states: Map<string, string>` - Tracks state transitions

**Request handling:**
All requests are handled in `handle(req, res)` which:
1. Parses the URL and method
2. Extracts JSON body if present
3. Logs the request
4. Routes to the appropriate handler
5. Returns JSON responses (or 204 for DELETE)

**Fake codespace creation:**
- POST to `/user/codespaces` creates a fake codespace with:
  - Auto-generated name: `fake-codespace-<id>`
  - State: `provisioning`
  - Default repository: `octocat/hello-world`
  - Default machine: `basicLinux32gb`

**State transitions:**
- POST to `/user/codespaces/{name}/start` - sets state to `available`
- POST to `/user/codespaces/{name}/stop` - sets state to `shutdown`
- DELETE to `/user/codespaces/{name}` - removes codespace

**Repository data:**
- Hardcoded repository: `octocat/hello-world` with id 42
- Hardcoded branch: `main` with sha `abc123`
- Hardcoded machines: `[{ name: 'basicLinux32gb', display_name: 'Basic' }]`

**Devcontainer handling:**
- GET returns fake devcontainer content
- PUT accepts and returns success

### 2. FakeHarnessRuntime

A lightweight HTTP server that mimics the DeepSeek Harness runtime:

**Constructor and lifecycle:**
- `static async start()` - Creates server, starts listening on ephemeral port
- `get baseUrl()` - Returns `http://127.0.0.1:<port>`
- `async stop()` - Stops the server

**Endpoints:**
- `GET /health` - Returns `{ status: 'ok', runtime: 'fake-harness' }`
- `POST /session` - Creates session, returns `{ id: 'fake-session', cwd: '/workspaces/hello-world' }`
- `POST /fs/read` - Reads file, returns `{ content: 'fake-content-of-<path>' }`
- `POST /terminal` - Executes command, returns `{ output: 'fake-output-of-<command>', exitCode: 0 }`
- `GET /events` - Returns SSE stream with `ready` event

**Purpose:**
The fake harness allows testing the complete connection flow:
1. SSH bootstrap deploys helper
2. Harness process starts via SSH
3. Connection parses launch URL with port
4. Forwarded URL points to this fake runtime
5. Client can connect and make requests

### Test usage pattern

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FakeGitHubApi, FakeHarnessRuntime } from '@deepseek-ai/dsh-codespaces-fakes'

describe('Codespaces integration', () => {
  let fakeGitHub: FakeGitHubApi
  let fakeHarness: FakeHarnessRuntime

  beforeEach(async () => {
    fakeGitHub = await FakeGitHubApi.start()
    fakeHarness = await FakeHarnessRuntime.start()
  })

  afterEach(async () => {
    await fakeHarness.stop()
    await fakeGitHub.stop()
  })

  it('creates a codespace and connects', async () => {
    // Configure service with fake API base
    // Run integration test
    
    // Verify requests
    expect(fakeGitHub.requests).toContainEqual({
      method: 'POST',
      path: '/user/codespaces',
      body: expect.objectContaining({ repository_id: 42 })
    })
  })
})
```

### Why fakes instead of mocks?

These are **server fakes** (real HTTP servers) rather than function mocks because:
1. The codespaces service uses `fetch()` for HTTP requests
2. We want to test the actual HTTP client code
3. We want to verify the exact request shapes sent
4. We need to simulate the async nature of HTTP

### Why separate fake runtime?

The harness runtime has its own API (health, session, fs, terminal, events) that is distinct from the GitHub API. Separating them allows:
- Testing the SSH port forwarding resolution
- Testing the complete connection flow end-to-end
- Verifying that the client connects to the correct forwarded URL

### Thread safety

These fakes use ephemeral ports and are designed to be started/stopped in test lifecycles. They are **not** designed for concurrent use by multiple tests; each test should create its own fakes.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Codespaces package](../../codespaces/codespaces/README.md) — the real GitHub API service.
- [Codespaces connection package](../../codespaces/codespaces-connection/README.md) — the service that uses these fakes in tests.
- [Test support packages](../../README.md) — other test utilities.

<a id="model-experience"></a>
## Model Experience

None, as this package is test infrastructure only.

#### KV Cache effect

None; this package registers nothing model-facing.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The fake GitHub API has hardcoded repository and branch data; dynamic data would require configuration.
- The fake does not implement pagination for list endpoints.
- The fake does not validate request bodies beyond JSON parsing.
- The fake does not implement rate limiting.
- The fake Harness runtime has minimal endpoints; adding more requires updating the fake.
- Ephemeral port assignment may fail if too many ports are in use.

<details>
<summary>Working context for maintainers — click to expand</summary>

This package is **test-support only**. It:
- Is not included in any production bundle
- Has no runtime dependencies beyond Node.js standard library
- Has no security requirements (it's a test fake)
- Should never be imported by production code

The fakes are intentionally simple. If you need more realistic behavior, add it to the fake server rather than mocking at a higher level.

</details>
