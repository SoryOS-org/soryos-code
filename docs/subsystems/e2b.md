# E2B Sandbox Connection

English | [中文](e2b.zh.md)

The [E2B connection](../../packages/e2b/e2b/README.md) owns one remote sandbox per composing context: create it, adopt an existing sandbox by ID, pause and resume it, destroy it, and initialize its workspace directory. Only lifecycle operations contact the E2B control plane, each carrying the deployment API key and the configured request deadline; no request runs when the plugin loads or disposes. Operations run one at a time behind a single queue, so `status()` always reports one local state — `absent`, `starting`, `ready`, `paused`, or `failed` — together with the last failure message. Consumers read the SDK handle from `ctx.e2b.sandbox` and use its filesystem operations directly.

Source: [`packages/e2b/e2b/src/index.ts`](../../packages/e2b/e2b/src/index.ts)

## Configuration

```ts type-equiv
/** Deployment-owned E2B coordinates; no model argument selects these values. */
interface Config {
  /** E2B API key for every control-plane call; absent reads apiKeyEnv from the process environment. */
  apiKey?: string
  /** Environment variable read for the E2B API key when apiKey is absent. */
  apiKeyEnv: string
  /** E2B control-plane domain; absent uses the SDK default domain. */
  domain?: string
  /** Sandbox template name or ID passed to every create. */
  template?: string
  /** Sandbox lifetime in milliseconds passed to create, connect, and resume, at most 86,400,000 (24 hours). */
  timeoutMs?: number
  /** Control-plane request deadline in milliseconds passed to every E2B API call. */
  requestTimeoutMs?: number
  /** Absolute sandbox directory created by initWorkspace. */
  workspace: string
}
```

The Loader validates the configuration before the plugin mounts: `workspace` is required, `timeoutMs` spans 1,000 through 86,400,000 milliseconds, and `requestTimeoutMs` spans 1,000 through 2,147,483,647 milliseconds. `apiKey` is marked secret and overrides `apiKeyEnv` (default `E2B_API_KEY`); a missing or empty key fails the first lifecycle call with the environment variable named. Each call re-resolves the key and builds fresh options carrying the configured domain, the request deadline, and the caller's cancellation signal.

## Lifecycle

Every operation enters one promise queue and starts only after the previous operation settled, success or failure, so concurrent callers cannot interleave transitions. `create` and `connect` require an unowned connection; a second owner is refused with the held sandbox's ID, and an empty sandbox ID is rejected before any request.

The local states are `absent`, `starting`, `ready`, `paused`, and `failed`. A successful operation clears the recorded failure; a rejected one keeps ownership unchanged and records its message in `status()`. An aborted control-plane call can abandon a sandbox E2B already started — the connection never reconnects to confirm it, and the abandoned sandbox expires with the `timeoutMs` sent on create.

`initWorkspace` requires a `ready` sandbox and creates the configured directory recursively, keeping an existing one. `destroy` kills the owned sandbox before releasing it; a rejected kill keeps the sandbox owned and records the failure.

Disposal drops the local handle and state without an API call, so application teardown never blocks on the network; the remote sandbox then lives only until its bounded lifetime ends.

## Connection API

```ts public-api
/**
 * One E2B connection: it serializes create, connect, pause, resume, and destroy,
 * and drops local ownership at disposal without killing the remote sandbox.
 */
declare class E2bConnection extends Service {
  /** Loader defaults, bounds, and the secret key field for this connection. */
  static Config: schema<Config>;
  constructor(ctx: Context, config: Config);
  /** Current lifecycle state, read from local memory. */
  get state(): E2bState;
  /** Absolute workspace directory every session in this connection starts from. */
  get workspace(): string;
  /** SDK handle of the owned sandbox; throws while this connection owns none. */
  get sandbox(): Sandbox;
  /**
     * Local lifecycle snapshot.
     * @returns state, the owned sandbox ID when one is owned, and the last failure message.
     */
  status(): E2bStatus;
  /**
     * Create a new sandbox and own it until destroy.
     * @param signal - cancels the control-plane request; a rejected create leaves this connection failed without a sandbox.
     * @returns the running sandbox handle.
     */
  async create(signal?: AbortSignal): Promise<Sandbox>;
  /**
     * Own an existing sandbox by ID; a paused sandbox resumes to running.
     * @param sandboxId - ID reported by a previous create or status.
     * @param signal - cancels the control-plane request; a rejected connect leaves this connection failed without a sandbox.
     * @returns the running sandbox handle.
     */
  async connect(sandboxId: string, signal?: AbortSignal): Promise<Sandbox>;
  /**
     * Pause the owned sandbox, keeping its filesystem and memory for a later resume.
     * @param signal - cancels the control-plane request; a rejected pause keeps the current state and records the failure.
     * @returns a promise that settles once E2B reports the pause settled.
     */
  async pause(signal?: AbortSignal): Promise<void>;
  /**
     * Reconnect and resume the owned paused sandbox to running; a ready sandbox is a no-op.
     * @param signal - cancels the control-plane request; a rejected resume keeps the current state and records the failure.
     * @returns a promise that settles once E2B reports the sandbox running.
     */
  async resume(signal?: AbortSignal): Promise<void>;
  /**
     * Kill the owned sandbox and release it; a sandbox E2B no longer reports is still released.
     * @param signal - cancels the control-plane request; a rejected kill keeps the sandbox owned and records the failure.
     * @returns a promise that settles once the local handle is released.
     */
  async destroy(signal?: AbortSignal): Promise<void>;
  /**
     * Create the configured workspace directory in the running sandbox; an existing directory is kept.
     * @param signal - cancels the filesystem request; a rejected call keeps the connection state unchanged and records the failure.
     * @returns a promise that settles once the directory exists.
     */
  async initWorkspace(signal?: AbortSignal): Promise<void>;
}
```

The `sandbox` getter exposes the SDK handle while the connection owns one and throws otherwise. `state` and `status()` read local memory only and never contact E2B, so remote drift — manual deletion or E2B-side expiry — surfaces on the next operation instead of in status.

## Filesystem provider

[`dsh-fs-e2b`](../../packages/e2b/fs-e2b/README.md) mounts beside the connection and provides `ctx.fs` over the sandbox workspace, so file tools and sandbox processes share one filesystem. It injects `ctx.e2b`: `resolve()` and every read, write, and edit run against the connection's sandbox, relative paths default to the workspace directory, and SDK failures map to the filesystem error codes the local provider reports. Its Loader configuration (`cwd`, `diffBasisMaxBytes`) is listed in the [config catalog](../config-catalog.md#deepseek-aidsh-fs-e2b).

Path identity follows symbolic links within one POSIX namespace, versions come from sandbox metadata, and writes and edits hold a per-target lock across read, stale-version guard, and publish. Watching and host-path mapping are unsupported; the package README records the rest of the limitations.

Source: [`packages/e2b/fs-e2b/src/index.ts`](../../packages/e2b/fs-e2b/src/index.ts)

## Subprocess provider

[`dsh-subprocess-e2b`](../../packages/e2b/subprocess-e2b/README.md) mounts beside the connection and provides `ctx.subprocess` over the sandbox, so shell commands and interactive terminals run in the same remote world as the files. It injects `ctx.e2b`: spawn validation stays synchronous while remote state directories, process-group publication, and the `SIGTERM`-to-`SIGKILL` termination ladder run against the connection's sandbox, and a sandbox that vanishes mid-command settles the affected commands as ended instead of erroring. Its Loader configuration (`pollMs`) is listed in the [config catalog](../config-catalog.md#deepseek-aidsh-subprocess-e2b).

Commands stream, collect, or spill output with bounded retention, terminals allocate through the sandbox PTY with resize and foreground-group inspection, and `control` stays absent because the transport carries no PTC control channel. Terminal activity always reports unknown, so inactivity never reclaims a terminal; the package README records the rest of the limitations.

Source: [`packages/e2b/subprocess-e2b/src/index.ts`](../../packages/e2b/subprocess-e2b/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxe2b--e2bconnection"></a>

### `ctx.e2b` — `E2bConnection`

One E2B connection: it serializes create, connect, pause, resume, and destroy, and drops local ownership at disposal without killing the remote sandbox.

```ts cordis-catalog
/**
 * Local lifecycle snapshot.
 * @returns state, the owned sandbox ID when one is owned, and the last failure message.
 */
status(): E2bStatus

/**
 * Create a new sandbox and own it until destroy.
 * @param signal - cancels the control-plane request; a rejected create leaves this connection failed without a sandbox.
 * @returns the running sandbox handle.
 */
async create(signal?: AbortSignal): Promise<Sandbox>

/**
 * Own an existing sandbox by ID; a paused sandbox resumes to running.
 * @param sandboxId - ID reported by a previous create or status.
 * @param signal - cancels the control-plane request; a rejected connect leaves this connection failed without a sandbox.
 * @returns the running sandbox handle.
 */
async connect(sandboxId: string, signal?: AbortSignal): Promise<Sandbox>

/**
 * Pause the owned sandbox, keeping its filesystem and memory for a later resume.
 * @param signal - cancels the control-plane request; a rejected pause keeps the current state and records the failure.
 * @returns a promise that settles once E2B reports the pause settled.
 */
async pause(signal?: AbortSignal): Promise<void>

/**
 * Reconnect and resume the owned paused sandbox to running; a ready sandbox is a no-op.
 * @param signal - cancels the control-plane request; a rejected resume keeps the current state and records the failure.
 * @returns a promise that settles once E2B reports the sandbox running.
 */
async resume(signal?: AbortSignal): Promise<void>

/**
 * Kill the owned sandbox and release it; a sandbox E2B no longer reports is still released.
 * @param signal - cancels the control-plane request; a rejected kill keeps the sandbox owned and records the failure.
 * @returns a promise that settles once the local handle is released.
 */
async destroy(signal?: AbortSignal): Promise<void>

/**
 * Create the configured workspace directory in the running sandbox; an existing directory is kept.
 * @param signal - cancels the filesystem request; a rejected call keeps the connection state unchanged and records the failure.
 * @returns a promise that settles once the directory exists.
 */
async initWorkspace(signal?: AbortSignal): Promise<void>
```

Source: [`packages/e2b/e2b/src/index.ts`](../../packages/e2b/e2b/src/index.ts)
<!-- END GENERATED cordis-surface -->
