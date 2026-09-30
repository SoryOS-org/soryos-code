/**
 * GitHub authorization home (`ctx.github`): one authorization flow writing the
 * `credentialKey('github', 'codespaces')` grant, plus the server-side token
 * resolution every GitHub API consumer uses. The OAuth device flow carries no
 * client secret, so the browser never sees a powerful credential; the PAT
 * method is the fallback for fine-grained tokens. The token is stored through
 * `ctx.credentials` and never crosses the Remote wire.
 * @module @deepseek-ai/dsh-github-auth
 */

import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { userAgent } from '@deepseek-ai/dsh-llm'
import { credentialKey, type GrantRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationInteraction, AuthorizationOutcome, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { GitHubAuthConfig, GitHubAuthorizationView, GitHubGrant } from './types.ts'

export type { GitHubAuthConfig, GitHubAuthorizationView, GitHubGrant } from './types.ts'

/** The credential record this flow writes. */
export const GITHUB_CREDENTIAL_KEY = credentialKey('github', 'codespaces')

const DEFAULT_SCOPES = ['codespace', 'read:user'] as const
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_flow'

const grantSchema = z.object({
  kind: z.literal('github-grant'),
  accessToken: z.string().min(1),
  tokenType: z.union([z.literal('bearer'), z.literal('token')]),
  scope: z.string(),
  method: z.union([z.literal('oauth-device'), z.literal('pat')]),
}).strict()

const deviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().nonnegative(),
}).strict()

const deviceTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  scope: z.string(),
}).strict()

const deviceErrorSchema = z.object({
  error: z.union([
    z.literal('authorization_pending'),
    z.literal('slow_down'),
    z.literal('expired_token'),
    z.literal('access_denied'),
  ]),
  error_description: z.string().optional(),
}).strict()

const userSchema = z.object({
  login: z.string().min(1),
}).strict()

interface ResolvedConfig {
  readonly clientId: string | undefined
  readonly scopes: readonly string[]
  readonly apiBase: string
  readonly deviceBase: string
  readonly pollIntervalMs: number
  readonly requestTimeoutMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    github: GitHubService
  }
}

/** One GitHub API failure with its HTTP status, for structured diagnostics. */
export class GitHubAuthError extends Error {
  /**
   * @param message - provider-safe diagnostic; never carries the token.
   * @param status - HTTP status when the failure came from GitHub.
   */
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GitHubAuthError'
  }
}

/** `ctx.github`: the GitHub authorization flow owner and token resolver. */
export class GitHubService extends Service {
  static inject = ['credentials', 'authorization']

  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: GitHubAuthConfig) {
    super(ctx, 'github')
    this.config = {
      clientId: config.clientId,
      scopes: config.scopes ?? DEFAULT_SCOPES,
      apiBase: config.apiBase ?? 'https://api.github.com',
      deviceBase: config.deviceBase ?? 'https://github.com',
      pollIntervalMs: config.pollIntervalMs ?? 5_000,
      requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
    }
    this.ctx.authorization.registerFlow({
      key: GITHUB_CREDENTIAL_KEY,
      label: 'GitHub',
      methods: [
        { id: 'oauth-device', label: 'GitHub account (browser)' },
        { id: 'pat', label: 'Personal access token' },
      ],
      run: (session) => {
        if (session.method === 'oauth-device') return this.runDeviceFlow(session)
        if (session.method === 'pat') return this.runPatFlow(session)
        return Promise.reject(new GitHubAuthError(`unknown GitHub authorization method "${session.method}"`))
      },
    })
  }

  /**
   * Resolve the stored GitHub token for server-side API calls.
   * @param signal - cancels the read.
   * @returns the token, or undefined while no grant is stored.
   */
  async resolveToken(signal?: AbortSignal): Promise<string | undefined> {
    return (await this.readGrant(signal))?.accessToken
  }

  /** Presence and method facts for configuration UIs — never the token. */
  async describe(): Promise<GitHubAuthorizationView> {
    const entry = this.ctx.authorization.describe(GITHUB_CREDENTIAL_KEY)
    const grant = await this.readGrant()
    return {
      key: GITHUB_CREDENTIAL_KEY,
      label: entry?.label ?? 'GitHub',
      methods: entry?.methods ?? [],
      configured: grant !== undefined,
      inFlight: entry?.inFlight ?? false,
    }
  }

  /**
   * Begin one authorization attempt through the registered flow.
   * @param interaction - the surface rendering notices and prompts.
   * @param method - `oauth-device` or `pat`; defaults to the flow's first.
   * @param signal - withdraws the attempt.
   * @returns the outcome once the attempt settles.
   */
  async beginAuthorization(interaction: AuthorizationInteraction, method?: string, signal?: AbortSignal): Promise<AuthorizationOutcome> {
    return await this.ctx.authorization.begin({
      key: GITHUB_CREDENTIAL_KEY,
      ...(method === undefined ? {} : { method }),
      interaction,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /** Withdraw the attempt running for this key, if any. */
  cancelAuthorization(): void {
    this.ctx.authorization.cancel(GITHUB_CREDENTIAL_KEY)
  }

  /** Remove the stored grant; an absent grant is a no-op. */
  async signOut(): Promise<void> {
    await this.ctx.credentials.deleteRecord(GITHUB_CREDENTIAL_KEY)
  }

  /** Read and validate the stored grant; every call reads the store, so a rotated token is seen immediately. */
  private async readGrant(signal?: AbortSignal): Promise<GitHubGrant | undefined> {
    const record = await this.ctx.credentials.readRecord(GITHUB_CREDENTIAL_KEY)
    if (record === undefined || record.kind !== 'grant') return undefined
    const parsed = grantSchema.safeParse(record.payload)
    if (!parsed.success) return undefined
    signal?.throwIfAborted()
    return parsed.data
  }

  private async request(method: string, url: string, body: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const bounded = signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const response = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        'user-agent': userAgent(),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: bounded,
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text)
    } catch {
      throw new GitHubAuthError(`GitHub returned a non-JSON response (HTTP ${response.status})`, response.status)
    }
    if (!response.ok) {
      const message = typeof parsed === 'object' && parsed !== null && 'message' in parsed && typeof parsed.message === 'string'
        ? parsed.message
        : `GitHub request failed (HTTP ${response.status})`
      throw new GitHubAuthError(message, response.status)
    }
    return parsed
  }

  private async runDeviceFlow(session: AuthorizationSession): Promise<void> {
    if (this.config.clientId === undefined) {
      throw new GitHubAuthError('OAuth device flow requires a configured GitHub OAuth App client id')
    }
    const code = deviceCodeSchema.parse(await this.request('POST', `${this.config.deviceBase}/login/device/code`, {
      client_id: this.config.clientId,
      scope: this.config.scopes.join(' '),
    }, session.signal))
    session.notify({
      message: `Open ${code.verification_uri} and enter the code ${code.user_code} to authorize SoryCode to manage GitHub Codespaces.`,
      url: code.verification_uri,
      code: code.user_code,
    })
    const deadline = Date.now() + code.expires_in * 1_000
    let interval = Math.max(code.interval, this.config.pollIntervalMs / 1_000) * 1_000
    for (;;) {
      session.signal.throwIfAborted()
      if (Date.now() >= deadline) throw new GitHubAuthError('the GitHub device code expired before authorization completed')
      await new Promise<void>(resolve => setTimeout(resolve, interval))
      session.signal.throwIfAborted()
      const raw = await this.request('POST', `${this.config.deviceBase}/login/oauth/access_token`, {
        client_id: this.config.clientId,
        device_code: code.device_code,
        grant_type: DEVICE_GRANT_TYPE,
      }, session.signal)
      const pending = deviceErrorSchema.safeParse(raw)
      if (pending.success) {
        if (pending.data.error === 'slow_down') {
          interval += 5_000
          continue
        }
        if (pending.data.error === 'authorization_pending') continue
        throw new GitHubAuthError(pending.data.error_description ?? `GitHub device authorization failed (${pending.data.error})`)
      }
      const token = deviceTokenSchema.parse(raw)
      await session.commit({ kind: 'grant', payload: {
        kind: 'github-grant',
        accessToken: token.access_token,
        tokenType: 'bearer',
        scope: token.scope,
        method: 'oauth-device',
      } satisfies GrantRecord['payload'] })
      return
    }
  }

  private async runPatFlow(session: AuthorizationSession): Promise<void> {
    const token = await session.prompt({
      kind: 'secret',
      message: 'Paste a GitHub personal access token (classic with the `codespace` scope, or fine-grained with Codespaces read/write).',
      placeholder: 'ghp_… or github_pat_…',
    })
    const verified = userSchema.safeParse(await this.request('GET', `${this.config.apiBase}/user`, {}, session.signal))
    if (!verified.success) throw new GitHubAuthError('the GitHub token was rejected (HTTP 401); check its scopes', 401)
    await session.commit({ kind: 'grant', payload: {
      kind: 'github-grant',
      accessToken: token,
      tokenType: 'token',
      scope: '',
      method: 'pat',
    } satisfies GrantRecord['payload'] })
  }
}

export const name = 'github-auth'

export const inject = ['credentials', 'authorization'] as const

export const Config: schema<GitHubAuthConfig> = schema.object({
  clientId: schema.string(),
  scopes: schema.array(schema.string()) as unknown as schema<readonly string[]>,
  apiBase: schema.string(),
  deviceBase: schema.string(),
  pollIntervalMs: schema.number(),
  requestTimeoutMs: schema.number(),
})

/**
 * Register the GitHub authorization flow and the `ctx.github` service.
 * @param ctx - the host context.
 * @param config - deployment-owned OAuth App identity and endpoints.
 */
export function apply(ctx: Context, config: GitHubAuthConfig): void {
  ctx.plugin(GitHubService, config)
}

export default GitHubService
