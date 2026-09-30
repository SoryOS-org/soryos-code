/**
 * Wire-safe Codespaces connection types: the lifecycle states, the remote
 * workspace target, and the structured error taxonomy. Types only.
 * @module @deepseek-ai/dsh-codespaces-connection/types
 */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
/**
 * The Codespaces environment lifecycle. The local state is a projection; the
 * authoritative codespace state is GitHub's, re-read at every transition.
 */
export type CodespaceLifecycle = 'none' | 'creating' | 'starting' | 'started' | 'bootstrapping' | 'harness-starting' | 'ready' | 'connected' | 'stopping' | 'stopped' | 'error' | 'reconnecting'
/** The remote workspace a connected Codespace exposes to SoryCode. */
export interface RemoteWorkspaceTarget {
  /** The forwarded HTTPS URL of the remote DeepSeek Harness web UI. */
  readonly url: URL
  /** The workspace this target belongs to. */
  readonly workspaceId: WorkspaceId
  /** The execution environment kind. */
  readonly environment: 'codespaces'
}
/** Structured failure codes; route on these, never by parsing messages. */
export type CodespaceConnectionErrorCode =
  | 'NO_ENVIRONMENT_CONFIGURED'
  | 'CODESPACE_UNAVAILABLE'
  | 'CODESPACE_PROVISION_TIMEOUT'
  | 'SSH_CONFIG_FAILED'
  | 'HELPER_DEPLOY_FAILED'
  | 'HARNESS_LAUNCH_FAILED'
  | 'ENDPOINT_UNRESOLVED'
  | 'TRANSPORT'
