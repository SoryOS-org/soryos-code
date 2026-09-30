/**
 * Wire-safe Codespaces controller types: every request and value crossing the
 * Remote `codespaces` namespace. Types only — no runtime code.
 * @module @deepseek-ai/dsh-api-codespaces-controller/types
 */
import type { AuthorizationMethod } from '@deepseek-ai/dsh-authorization/types'
import type { CodespaceLifecycle } from '@deepseek-ai/dsh-codespaces-connection/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
/** The environment configuration a workspace stores before provisioning. */
export interface CodespacesEnvironmentConfig {
  /** `owner/name` of an existing, accessible repository. */
  readonly repository: string
  /** Git ref; the repository default branch when omitted. */
  readonly branch?: string
  /** Machine type from `listMachines`. */
  readonly machine?: string
  /** Idle timeout in minutes. */
  readonly idleTimeoutMinutes?: number
  /** Retention period in minutes. */
  readonly retentionPeriodMinutes?: number
  /** Azure region. */
  readonly location?: string
  /** User-facing display name. */
  readonly displayName?: string
}
/** The environment status projection the UI renders. */
export interface CodespacesStatusValue {
  /** The lifecycle state. */
  readonly lifecycle: CodespaceLifecycle
  /** Whether a Codespaces environment is configured for the workspace. */
  readonly configured: boolean
  /** The configured repository. */
  readonly repository?: string
  /** The configured branch. */
  readonly branch?: string
  /** The configured machine. */
  readonly machine?: string
  /** The provisioned codespace name. */
  readonly codespaceName?: string
  /** The GitHub-reported codespace state. */
  readonly codespaceState?: string
  /** The forwarded workspace URL once connected. */
  readonly workspaceUrl?: string
  /** GitHub authorization facts — never a token. */
  readonly authorization: {
    readonly configured: boolean
    readonly methods: readonly AuthorizationMethod[]
  }
}
/** One authorization notice frame on the `followAuthorization` stream. */
export interface AuthorizationNoticeFrame {
  readonly kind: 'notice'
  readonly message: string
  readonly url?: string
  readonly code?: string
}
/** One authorization prompt frame on the `followAuthorization` stream. */
export interface AuthorizationPromptFrame {
  readonly kind: 'prompt'
  readonly promptId: string
  readonly message: string
  readonly secret: boolean
}
/** One authorization settlement frame on the `followAuthorization` stream. */
export interface AuthorizationSettlementFrame {
  readonly kind: 'settlement'
  readonly authorized: boolean
}
/** The configure request. */
export interface CodespacesConfigureRequest {
  readonly workspaceId: WorkspaceId
  readonly config: CodespacesEnvironmentConfig
}
/** The configure value. */
export interface CodespacesConfigureValue {
  readonly workspaceId: WorkspaceId
  readonly repository: string
  readonly branch?: string
  readonly machine?: string
}
/** The workspace-scoped request carried by every lifecycle operation. */
export interface CodespacesWorkspaceRequest {
  readonly workspaceId: WorkspaceId
}
/** The connect value: the remote workspace URL the browser opens. */
export interface CodespacesConnectValue {
  readonly url: string
  readonly lifecycle: CodespaceLifecycle
}
/** The authorization entry value. */
export interface CodespacesAuthorizationValue {
  readonly configured: boolean
  readonly methods: readonly AuthorizationMethod[]
}
/** The begin-authorization request. */
export interface CodespacesBeginAuthorizationRequest {
  readonly method?: string
}
/** The answer-authorization request. */
export interface CodespacesAnswerAuthorizationRequest {
  readonly promptId: string
  readonly answer: string
}
