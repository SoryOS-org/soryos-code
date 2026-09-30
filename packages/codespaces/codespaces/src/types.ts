/**
 * Wire-safe Codespaces types: the stored codespace record, the lifecycle
 * states, the creation config, and the structured error taxonomy. Types only.
 * @module @deepseek-ai/dsh-codespaces/types
 */

/** One GitHub Codespace as the lifecycle service projects it. */
export interface Codespace {
  /** GitHub-assigned numeric id. */
  readonly id: number
  /** The immutable codespace name used by every lifecycle endpoint. */
  readonly name: string
  /** User-facing display name. */
  readonly displayName: string
  /** GitHub-reported state. */
  readonly state: CodespaceState
  /** The repository the codespace was created from. */
  readonly repository: CodespaceRepository
  /** The machine type (e.g. `basicLinux32gb`). */
  readonly machine: string
  /** Devcontainer path when one was requested. */
  readonly devcontainerPath?: string
  /** Azure region when one was requested. */
  readonly location?: string
  /** Idle timeout in minutes. */
  readonly idleTimeoutMinutes?: number
  /** Retention period in minutes. */
  readonly retentionPeriodMinutes?: number
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string
  /** ISO-8601 last-update timestamp. */
  readonly updatedAt: string
  /** ISO-8601 last-use timestamp. */
  readonly lastUsedAt?: string
  /** Web URL of the codespace. */
  readonly url: string
  /** API URL of the codespace. */
  readonly apiUrl: string
}

/** The GitHub-reported codespace states. */
export type CodespaceState =
  | 'queued'
  | 'provisioning'
  | 'available'
  | 'awaiting'
  | 'unavailable'
  | 'shutdown'
  | 'archived'
  | 'deleted'
  | 'moved'
  | 'exported'
  | 'created'
  | 'failed'

/** Whether a state accepts a start request. */
export function isStartableState(state: CodespaceState): boolean {
  return state === 'shutdown' || state === 'archived'
}

/** Whether a state accepts a stop request. */
export function isStoppableState(state: CodespaceState): boolean {
  return state === 'available' || state === 'awaiting'
}

/** Whether a state means the codespace is usable. */
export function isReadyState(state: CodespaceState): boolean {
  return state === 'available'
}

/** The repository half of a codespace record. */
export interface CodespaceRepository {
  readonly id: number
  /** `owner/name`. */
  readonly fullName: string
  readonly name: string
  readonly owner: string
  /** The repository default branch. */
  readonly defaultBranch: string
}

/** One repository as the picker projects it. */
export interface RepositorySummary {
  /** `owner/name`. */
  readonly fullName: string
  readonly name: string
  readonly owner: string
  readonly isPrivate: boolean
  readonly defaultBranch: string
}

/** One branch as the picker projects it. */
export interface BranchSummary {
  readonly name: string
  readonly sha: string
}

/** One available machine type for a repository. */
export interface MachineSummary {
  readonly name: string
  readonly displayName: string
}

/** The creation request; every field except the repository is optional. */
export interface CreateCodespaceInput {
  /** `owner/name` of an existing, accessible repository. */
  readonly repository: string
  /** Git ref (branch, tag, or commit SHA). @default the repository default branch */
  readonly branch?: string
  /** Machine type from {@link CodespaceService.listMachines}. */
  readonly machine?: string
  /** Devcontainer path inside the repository. @default '.devcontainer/devcontainer.json' */
  readonly devcontainerPath?: string
  /** Idle timeout in minutes. */
  readonly idleTimeoutMinutes?: number
  /** Retention period in minutes (0–43200). */
  readonly retentionPeriodMinutes?: number
  /** Azure region. */
  readonly location?: string
  /** User-facing display name. */
  readonly displayName?: string
}

/** Structured failure codes; route on these, never by parsing messages. */
export type CodespaceErrorCode =
  | 'CODESPACE_AUTH'
  | 'CODESPACE_FORBIDDEN'
  | 'CODESPACE_NOT_FOUND'
  | 'CODESPACE_QUOTA'
  | 'CODESPACE_UNAVAILABLE'
  | 'CODESPACE_INVALID_REPOSITORY'
  | 'CODESPACE_INVALID_REF'
  | 'CODESPACE_API'
