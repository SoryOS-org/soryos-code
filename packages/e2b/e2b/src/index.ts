/** E2B sandbox connection owner: one remote sandbox, serialized lifecycle, no network at load or disposal. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { Sandbox } from 'e2b'
import type { ConnectionOpts, SandboxConnectOpts, SandboxOpts } from 'e2b'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Side-effect type import: declaration-merges the credentials seam resolved per call.
import type {} from '@deepseek-ai/dsh-credentials'
// Side-effect type import: declaration-merges the settings namespace configured below.
import type {} from '@deepseek-ai/dsh-settings'

/**
 * Deployment-owned E2B coordinates; no model argument selects these values.
 * `workspace` stays ordinary because the preset owns it, while every other field
 * is volatile so the session settings card owns it.
 */
export interface Config {
  /** E2B API key literal for every control-plane call; the credentials store and `apiKeyEnv` answer when absent. */
  apiKey?: string
  /** Credential reference naming the E2B API key; defaults to `E2B_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** E2B control-plane domain; absent uses the SDK default domain. */
  domain: Volatile<string | undefined>
  /** Sandbox template name or ID passed to every create. */
  template: Volatile<string | undefined>
  /** Sandbox lifetime in milliseconds passed to create, connect, and resume, at most 86,400,000 (24 hours). */
  timeoutMs: Volatile<number | undefined>
  /** Control-plane request deadline in milliseconds passed to every E2B API call. */
  requestTimeoutMs: Volatile<number | undefined>
  /** Absolute sandbox directory created by initWorkspace. */
  workspace: string
}

/**
 * Plain deployment inputs the Loader accepts for this connection. Every field
 * but `workspace` is optional: the schema supplies the defaults, and the
 * volatile fields reach the plugin as stable references.
 */
export interface ConfigInput {
  /** E2B API key literal for every control-plane call; the credentials store and `apiKeyEnv` answer when absent. */
  apiKey?: string
  /** Credential reference naming the E2B API key; defaults to `E2B_API_KEY`. */
  apiKeyEnv?: string
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

/** Lifecycle state of the owned sandbox, read from local memory without contacting E2B. */
export type E2bState = 'absent' | 'starting' | 'ready' | 'paused' | 'failed'

/** Local lifecycle snapshot; a later success clears `error`. */
export interface E2bStatus {
  /** Current lifecycle state. */
  state: E2bState
  /** ID of the sandbox while one is owned. */
  sandboxId?: string
  /** Message of the most recent failed operation. */
  error?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** One E2B connection per composing context. */
    e2b: E2bConnection
  }
}

/**
 * One E2B connection: it serializes create, connect, pause, resume, and destroy,
 * and drops local ownership at disposal without killing the remote sandbox.
 */
export class E2bConnection extends Service {
  /** Loader defaults, bounds, and the secret key field for this connection. */
  static Config: schema<ConfigInput, Config> = schema.object({
    apiKey: schema.string().role('secret'),
    apiKeyEnv: schema.string().role('credential-ref').default('E2B_API_KEY').volatile(),
    domain: schema.string().volatile(),
    template: schema.string().volatile(),
    timeoutMs: schema.number().step(1).min(1000).max(86_400_000).volatile(),
    requestTimeoutMs: schema.number().step(1).min(1000).max(2_147_483_647).volatile(),
    workspace: schema.string().required(),
  })

  private readonly options: Config
  private handle: Sandbox | undefined
  private current: E2bState = 'absent'
  private failure: string | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'e2b')
    this.options = config
    ctx.effect(() => () => { this.detach() })
    // The page policy is owned by this fiber, so unloading the connection withdraws it while `settings` keeps running.
    ctx.inject(['settings'], (child: Context) => {
      child.effect(() => child.settings.configure({ auto: true }, ctx.fiber))
    })
  }

  /** Current lifecycle state, read from local memory. */
  get state(): E2bState {
    return this.current
  }

  /** Absolute workspace directory every session in this connection starts from. */
  get workspace(): string {
    return this.options.workspace
  }

  /** SDK handle of the owned sandbox; throws while this connection owns none. */
  get sandbox(): Sandbox {
    if (this.handle === undefined) throw new Error(`E2B connection owns no sandbox while ${this.current}`)
    return this.handle
  }

  /**
   * Local lifecycle snapshot.
   * @returns state, the owned sandbox ID when one is owned, and the last failure message.
   */
  status(): E2bStatus {
    return {
      state: this.current,
      ...this.handle === undefined ? {} : { sandboxId: this.handle.sandboxId },
      ...this.failure === undefined ? {} : { error: this.failure },
    }
  }

  /**
   * Create a new sandbox and own it until destroy.
   * @param signal - cancels the control-plane request; a rejected create leaves this connection failed without a sandbox.
   * @returns the running sandbox handle.
   */
  async create(signal?: AbortSignal): Promise<Sandbox> {
    return this.enqueue(async () => {
      this.assertUnowned()
      this.current = 'starting'
      try {
        const opts: SandboxOpts = await this.connectionOpts(signal)
        const timeoutMs = this.options.timeoutMs.get()
        if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs
        const template = this.options.template.get()
        const sandbox = template === undefined
          ? await Sandbox.create(opts)
          : await Sandbox.create(template, opts)
        return this.adopt(sandbox)
      } catch (error) {
        this.current = 'failed'
        this.record(error)
        throw error
      }
    })
  }

  /**
   * Own an existing sandbox by ID; a paused sandbox resumes to running.
   * @param sandboxId - ID reported by a previous create or status.
   * @param signal - cancels the control-plane request; a rejected connect leaves this connection failed without a sandbox.
   * @returns the running sandbox handle.
   */
  async connect(sandboxId: string, signal?: AbortSignal): Promise<Sandbox> {
    return this.enqueue(async () => {
      this.assertUnowned()
      if (sandboxId === '') throw new Error('E2B sandbox ID must not be empty')
      this.current = 'starting'
      try {
        const opts: SandboxConnectOpts = await this.connectionOpts(signal)
        const timeoutMs = this.options.timeoutMs.get()
        if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs
        return this.adopt(await Sandbox.connect(sandboxId, opts))
      } catch (error) {
        this.current = 'failed'
        this.record(error)
        throw error
      }
    })
  }

  /**
   * Pause the owned sandbox, keeping its filesystem and memory for a later resume.
   * @param signal - cancels the control-plane request; a rejected pause keeps the current state and records the failure.
   * @returns a promise that settles once E2B reports the pause settled.
   */
  async pause(signal?: AbortSignal): Promise<void> {
    await this.enqueue(async () => {
      const handle = this.sandbox
      if (this.current === 'paused') return
      try {
        await handle.pause(await this.connectionOpts(signal))
        this.current = 'paused'
        this.failure = undefined
      } catch (error) {
        this.record(error)
        throw error
      }
    })
  }

  /**
   * Reconnect and resume the owned paused sandbox to running; a ready sandbox is a no-op.
   * @param signal - cancels the control-plane request; a rejected resume keeps the current state and records the failure.
   * @returns a promise that settles once E2B reports the sandbox running.
   */
  async resume(signal?: AbortSignal): Promise<void> {
    await this.enqueue(async () => {
      const handle = this.sandbox
      if (this.current === 'ready') return
      try {
        const opts: SandboxConnectOpts = await this.connectionOpts(signal)
        const timeoutMs = this.options.timeoutMs.get()
        if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs
        await handle.connect(opts)
        this.current = 'ready'
        this.failure = undefined
      } catch (error) {
        this.record(error)
        throw error
      }
    })
  }

  /**
   * Kill the owned sandbox and release it; a sandbox E2B no longer reports is still released.
   * @param signal - cancels the control-plane request; a rejected kill keeps the sandbox owned and records the failure.
   * @returns a promise that settles once the local handle is released.
   */
  async destroy(signal?: AbortSignal): Promise<void> {
    await this.enqueue(async () => {
      const handle = this.sandbox
      try {
        await handle.kill(await this.connectionOpts(signal))
      } catch (error) {
        this.record(error)
        throw error
      }
      this.handle = undefined
      this.current = 'absent'
      this.failure = undefined
    })
  }

  /**
   * Create the configured workspace directory in the running sandbox; an existing directory is kept.
   * @param signal - cancels the filesystem request; a rejected call keeps the connection state unchanged and records the failure.
   * @returns a promise that settles once the directory exists.
   */
  async initWorkspace(signal?: AbortSignal): Promise<void> {
    await this.enqueue(async () => {
      if (this.current !== 'ready' || this.handle === undefined) {
        throw new Error(`E2B workspace requires a running sandbox while ${this.current}`)
      }
      const requestTimeoutMs = this.options.requestTimeoutMs.get()
      const opts = {
        ...requestTimeoutMs === undefined ? {} : { requestTimeoutMs },
        ...signal === undefined ? {} : { signal },
      }
      try {
        await this.handle.files.makeDir(this.options.workspace, opts)
        this.failure = undefined
      } catch (error) {
        this.record(error)
        throw error
      }
    })
  }

  /** Refuse a second owner while a sandbox is held. */
  private assertUnowned(): void {
    if (this.handle !== undefined) throw new Error(`E2B connection already owns sandbox ${this.handle.sandboxId}`)
  }

  /** Take ownership of a running sandbox and clear the recorded failure. */
  private adopt(sandbox: Sandbox): Sandbox {
    this.handle = sandbox
    this.current = 'ready'
    this.failure = undefined
    return sandbox
  }

  /**
   * Resolve the E2B API key for one control-plane call.
   *
   * The literal `apiKey` wins, then the credentials store addressed by
   * `apiKeyEnv` — which is where the session settings card writes — then the
   * process environment. A key found in none of them fails before any request.
   * @returns the resolved API key.
   */
  private async resolveApiKey(): Promise<string> {
    const literal = this.options.apiKey
    if (literal !== undefined && literal !== '') return literal
    const reference = this.options.apiKeyEnv.get()
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      const stored = await credentials.resolve(credentialRef(reference))
      if (stored !== undefined && stored.value !== '') return stored.value
    }
    const ambient = process.env[reference]
    if (ambient !== undefined && ambient !== '') return ambient
    throw new Error(`E2B API key is not configured: set apiKey or the ${reference} credential reference`)
  }

  /**
   * Control-plane options for one call: resolved key, configured domain, deadline, and cancellation.
   * @param signal - cancels the SDK request.
   * @returns the connection options carrying the freshly resolved key.
   */
  private async connectionOpts(signal?: AbortSignal): Promise<ConnectionOpts> {
    const domain = this.options.domain.get()
    const requestTimeoutMs = this.options.requestTimeoutMs.get()
    return {
      apiKey: await this.resolveApiKey(),
      ...domain === undefined ? {} : { domain },
      ...requestTimeoutMs === undefined ? {} : { requestTimeoutMs },
      ...signal === undefined ? {} : { signal },
    }
  }

  /** Record the failure message of the last operation without its inputs. */
  private record(error: unknown): void {
    this.failure = error instanceof Error ? error.message : String(error)
  }

  /** Run one operation after every queued operation settled, accepting both outcomes. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Drop local ownership at disposal; the remote sandbox survives and no API call is made. */
  private detach(): void {
    this.handle = undefined
    this.current = 'absent'
    this.failure = undefined
  }
}

export default E2bConnection
