/**
 * Wire-safe GitHub authorization types: the stored grant payload, the service
 * view, and the plugin config. Types only — no runtime code.
 * @module @deepseek-ai/dsh-github-auth/types
 */

import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { AuthorizationEntry } from '@deepseek-ai/dsh-authorization/types'

/** One stored GitHub grant, opaque to every consumer except this package. */
export interface GitHubGrant {
  /** Discriminant. */
  readonly kind: 'github-grant'
  /** The OAuth access token or PAT; never leaves the host process. */
  readonly accessToken: string
  /** `bearer` for OAuth tokens, `token` for PATs. */
  readonly tokenType: 'bearer' | 'token'
  /** Granted scopes, space-separated as GitHub returns them. */
  readonly scope: string
  /** Which authorization method produced this grant. */
  readonly method: 'oauth-device' | 'pat'
}

/** Presence facts for configuration UIs — never the token. */
export interface GitHubAuthorizationView {
  /** The credential record this flow writes. */
  readonly key: CredentialKey
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** The methods this flow offers. */
  readonly methods: AuthorizationEntry['methods']
  /** Whether a grant is currently stored. */
  readonly configured: boolean
  /** Whether an attempt for this key is running now. */
  readonly inFlight: boolean
}

/** Deployment-owned GitHub authorization settings; no model argument selects these values. */
export interface GitHubAuthConfig {
  /**
   * OAuth App client id (public by design — the device flow carries no client
   * secret). Omitted: only the PAT method is offered.
   */
  readonly clientId?: string
  /** Requested OAuth scopes. @default 'codespace read:user' */
  readonly scopes?: readonly string[]
  /** GitHub REST API base. @default 'https://api.github.com' */
  readonly apiBase?: string
  /** GitHub device-flow base. @default 'https://github.com' */
  readonly deviceBase?: string
  /** Device-flow poll interval floor in milliseconds. @default 5000 */
  readonly pollIntervalMs?: number
  /** One device-flow request deadline in milliseconds. @default 30000 */
  readonly requestTimeoutMs?: number
}
