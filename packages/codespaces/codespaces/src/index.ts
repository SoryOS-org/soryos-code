/**
 * GitHub Codespaces lifecycle service (`ctx.codespaces`): the official REST API
 * behind one typed seam — create, get, list, start, stop, remove — plus the
 * repository, branch, and machine reads the configuration flow validates
 * against. Every failure is a structured {@link CodespaceError}; the GitHub
 * token is resolved per call through `ctx.github` and never leaves the host.
 * @module @deepseek-ai/dsh-codespaces
 */

import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { userAgent } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-github-auth'
import type {
  BranchSummary,
  Codespace,
  CodespaceErrorCode,
  CreateCodespaceInput,
  MachineSummary,
  RepositorySummary,
} from './types.ts'

export type {
  BranchSummary,
  Codespace,
  CodespaceErrorCode,
  CodespaceState,
  CreateCodespaceInput,
  MachineSummary,
  RepositorySummary,
} from './types.ts'
export { isReadyState, isStartableState, isStoppableState } from './types.ts'

/** One GitHub Codespaces API failure with a stable machine-routable code. */
export class CodespaceError extends HarnessError {
  /**
   * @param message - provider-safe diagnostic; never carries a token.
   * @param code - the structured failure code.
   * @param status - HTTP status when the failure came from GitHub.
   */
  constructor(message: string, code: CodespaceErrorCode, readonly status?: number) {
    super(message, code)
    this.name = 'CodespaceError'
  }
}

/** The devcontainer path inside the user repository. */
export const DEVCONTAINER_PATH = '.devcontainer/devcontainer.json'

const { version: DSH_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

/**
 * The devcontainer document SoryCode writes into the user repository before
 * creating a codespace: Node 22 (the harness runtime requirement), the SSH
 * server feature (the transport the remote provider family rides), port 3080
 * forwarding (the harness web UI), and the pinned harness install. The
 * non-root `node` user is the image default.
 */
export const DEVCONTAINER_JSON = JSON.stringify({
  name: 'SoryCode',
  image: 'mcr.microsoft.com/devcontainers/javascript-node:22',
  features: {
    'ghcr.io/devcontainers/features/sshd:1': {},
    'ghcr.io/devcontainers/features/common-utils:2': { installZsh: false, upgradePackages: false },
  },
  forwardPorts: [3080],
  portsAttributes: {
    3080: { label: 'DeepSeek Harness', onAutoForward: 'notify', visibility: 'private' },
  },
  postCreateCommand: `npm install -g @deepseek-ai/dsh@${DSH_VERSION}`,
  remoteUser: 'node',
}, null, 2)

const contentResponseSchema = z.object({
  content: z.string(),
  sha: z.string(),
  type: z.literal('file'),
}).strict()

/** Deployment-owned Codespaces API settings. */
export interface Config {
  /** GitHub REST API base. @default 'https://api.github.com' */
  readonly apiBase?: string
  /** One API request deadline in milliseconds. @default 30000 */
  readonly requestTimeoutMs?: number
}

interface ResolvedConfig {
  readonly apiBase: string
  readonly requestTimeoutMs: number
}

const codespaceStateSchema = z.union([
  z.literal('queued'), z.literal('provisioning'), z.literal('available'), z.literal('awaiting'),
  z.literal('unavailable'), z.literal('shutdown'), z.literal('archived'), z.literal('deleted'),
  z.literal('moved'), z.literal('exported'), z.literal('created'), z.literal('failed'),
])

const repositorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  default_branch: z.string(),
}).strict()

const codespaceResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  display_name: z.string(),
  state: codespaceStateSchema,
  repository: repositorySchema,
  machine: z.string(),
  devcontainer_path: z.string().optional(),
  location: z.string().optional(),
  idle_timeout_minutes: z.number().int().optional(),
  retention_period_minutes: z.number().int().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  last_used_at: z.string().optional(),
  url: z.string(),
  api_url: z.string(),
}).strict()

type CodespaceResponse = z.infer<typeof codespaceResponseSchema>

/** Project one GitHub codespace record onto the public {@link Codespace} type. */
function projectCodespace(record: CodespaceResponse): Codespace {
  return {
    id: record.id,
    name: record.name,
    displayName: record.display_name,
    state: record.state,
    repository: {
      id: record.repository.id,
      fullName: record.repository.full_name,
      name: record.repository.name,
      owner: record.repository.owner.login,
      defaultBranch: record.repository.default_branch,
    },
    machine: record.machine,
    ...(record.devcontainer_path === undefined ? {} : { devcontainerPath: record.devcontainer_path }),
    ...(record.location === undefined ? {} : { location: record.location }),
    ...(record.idle_timeout_minutes === undefined ? {} : { idleTimeoutMinutes: record.idle_timeout_minutes }),
    ...(record.retention_period_minutes === undefined ? {} : { retentionPeriodMinutes: record.retention_period_minutes }),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    ...(record.last_used_at === undefined ? {} : { lastUsedAt: record.last_used_at }),
    url: record.url,
    apiUrl: record.api_url,
  }
}

const branchSchema = z.object({
  name: z.string(),
  commit: z.object({ sha: z.string() }),
}).strict()

const machineSchema = z.object({
  name: z.string(),
  display_name: z.string(),
}).strict()

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/

declare module '@deepseek-ai/cordis' {
  interface Context {
    codespaces: CodespaceService
  }
}

/** `ctx.codespaces`: the GitHub Codespaces lifecycle owner. */
export class CodespaceService extends Service {
  static inject = ['github']

  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'codespaces')
    this.config = {
      apiBase: config.apiBase ?? 'https://api.github.com',
      requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
    }
  }

  /**
   * Validate the repository and ref, then create one codespace for the
   * authenticated user. The repository must exist and be accessible; the ref
   * must exist in it. Failures are structured: an inaccessible repository is
   * `CODESPACE_INVALID_REPOSITORY`, a missing ref is `CODESPACE_INVALID_REF`.
   * @param input - the creation request.
   * @param signal - cancels the validation and creation round-trips.
   * @returns the created codespace (state `queued` or `provisioning`).
   */
  async create(input: CreateCodespaceInput, signal?: AbortSignal): Promise<Codespace> {
    const repository = await this.getRepository(input.repository, signal)
    const ref = input.branch ?? repository.defaultBranch
    await this.getBranch(input.repository, ref, signal)
    const body: Record<string, unknown> = {
      repository_id: repository.id,
      ref,
      ...(input.machine === undefined ? {} : { machine: input.machine }),
      ...(input.devcontainerPath === undefined ? {} : { devcontainer_path: input.devcontainerPath }),
      ...(input.idleTimeoutMinutes === undefined ? {} : { idle_timeout_minutes: input.idleTimeoutMinutes }),
      ...(input.retentionPeriodMinutes === undefined ? {} : { retention_period_minutes: input.retentionPeriodMinutes }),
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
    }
    return projectCodespace(await this.post('/user/codespaces', body, codespaceResponseSchema, signal))
  }

  /**
   * Read one codespace by name.
   * @param name - the immutable codespace name.
   * @param signal - cancels the round-trip.
   * @returns the codespace.
   * @throws {CodespaceError} code `CODESPACE_NOT_FOUND` when no codespace carries that name.
   */
  async get(name: string, signal?: AbortSignal): Promise<Codespace> {
    return projectCodespace(await this.request('GET', `/user/codespaces/${encodeURIComponent(name)}`, codespaceResponseSchema, signal))
  }

  /**
   * List every codespace of the authenticated user.
   * @param signal - cancels the round-trip.
   * @returns all codespaces, newest first as GitHub returns them.
   */
  async list(signal?: AbortSignal): Promise<Codespace[]> {
    const response = await this.request('GET', '/user/codespaces', z.object({ codespaces: z.array(codespaceResponseSchema) }).strict(), signal)
    return response.codespaces.map(projectCodespace)
  }

  /**
   * Start a stopped codespace.
   * @param name - the immutable codespace name.
   * @param signal - cancels the round-trip.
   * @returns the codespace in its post-start state.
   */
  async start(name: string, signal?: AbortSignal): Promise<Codespace> {
    return projectCodespace(await this.post(`/user/codespaces/${encodeURIComponent(name)}/start`, {}, codespaceResponseSchema, signal))
  }

  /**
   * Stop a running codespace. The filesystem and its contents survive; the
   * processes do not.
   * @param name - the immutable codespace name.
   * @param signal - cancels the round-trip.
   * @returns the codespace in state `shutdown`.
   */
  async stop(name: string, signal?: AbortSignal): Promise<Codespace> {
    return projectCodespace(await this.post(`/user/codespaces/${encodeURIComponent(name)}/stop`, {}, codespaceResponseSchema, signal))
  }

  /**
   * Delete one codespace. Destructive and irreversible: the filesystem, the
   * devcontainer state, and every process are lost. The configuration that
   * created it is owned by the caller, not by this operation.
   * @param name - the immutable codespace name.
   * @param signal - cancels the round-trip.
   */
  async remove(name: string, signal?: AbortSignal): Promise<void> {
    const token = await this.token(signal)
    const response = await this.fetch('DELETE', `/user/codespaces/${encodeURIComponent(name)}`, token, signal)
    if (!response.ok) throw this.error(response.status, await response.text())
  }

  /**
   * List repositories the authenticated user can create codespaces in.
   * @param signal - cancels the round-trip.
   * @returns repositories with their default branch.
   */
  async listRepositories(signal?: AbortSignal): Promise<RepositorySummary[]> {
    const response = await this.request('GET', '/user/repos?per_page=100&sort=updated', z.array(repositorySchema), signal)
    return response.map(repository => ({
      fullName: repository.full_name,
      name: repository.name,
      owner: repository.owner.login,
      isPrivate: repository.private,
      defaultBranch: repository.default_branch,
    }))
  }

  /**
   * List branches of one repository.
   * @param repository - `owner/name`.
   * @param signal - cancels the round-trip.
   * @returns branch names with their head SHAs.
   */
  async listBranches(repository: string, signal?: AbortSignal): Promise<BranchSummary[]> {
    const response = await this.request('GET', `/repos/${repositoryPath(repository)}/branches?per_page=100`, z.array(branchSchema), signal)
    return response.map(branch => ({ name: branch.name, sha: branch.commit.sha }))
  }

  /**
   * List machine types available for codespaces in one repository.
   * @param repository - `owner/name`.
   * @param signal - cancels the round-trip.
   * @returns machine names with display labels.
   */
  async listMachines(repository: string, signal?: AbortSignal): Promise<MachineSummary[]> {
    const response = await this.request('GET', `/repos/${repositoryPath(repository)}/codespaces/machines`, z.object({ machines: z.array(machineSchema) }).strict(), signal)
    return response.machines.map(machine => ({ name: machine.name, displayName: machine.display_name }))
  }

  /**
   * Validate one repository and return its id.
   * @param repository - `owner/name`.
   * @param signal - cancels the round-trip.
   * @throws {CodespaceError} code `CODESPACE_INVALID_REPOSITORY` when missing or inaccessible.
   */
  async getRepository(repository: string, signal?: AbortSignal): Promise<Codespace['repository']> {
    let record: z.infer<typeof repositorySchema>
    try {
      record = await this.request('GET', `/repos/${repositoryPath(repository)}`, repositorySchema, signal)
    } catch (error) {
      if (error instanceof CodespaceError && error.status === 404) {
        throw new CodespaceError(
          `repository "${repository}" does not exist or is not accessible with the connected GitHub account`,
          'CODESPACE_INVALID_REPOSITORY', 404)
      }
      throw error
    }
    return {
      id: record.id,
      fullName: record.full_name,
      name: record.name,
      owner: record.owner.login,
      defaultBranch: record.default_branch,
    }
  }

  /**
   * Validate one ref exists in one repository.
   * @param repository - `owner/name`.
   * @param ref - branch, tag, or commit SHA.
   * @param signal - cancels the round-trip.
   * @throws {CodespaceError} code `CODESPACE_INVALID_REF` when the ref is missing.
   */
  async getBranch(repository: string, ref: string, signal?: AbortSignal): Promise<BranchSummary> {
    let record: z.infer<typeof branchSchema>
    try {
      record = await this.request('GET', `/repos/${repositoryPath(repository)}/branches/${encodeURIComponent(ref)}`, branchSchema, signal)
    } catch (error) {
      if (error instanceof CodespaceError && error.status === 404) {
        throw new CodespaceError(
          `ref "${ref}" does not exist in repository "${repository}"`,
          'CODESPACE_INVALID_REF', 404)
      }
      throw error
    }
    return { name: record.name, sha: record.commit.sha }
  }

  /**
   * Write the SoryCode devcontainer document into the user repository. An
   * existing file is updated in place (its current sha is required by the
   * contents API); a missing file is created. The codespace is then created
   * with `devcontainer_path` pointing at it.
   * @param repository - `owner/name`.
   * @param signal - cancels the read and write round-trips.
   */
  async writeDevcontainer(repository: string, signal?: AbortSignal): Promise<void> {
    const path = repositoryPath(repository)
    let sha: string | undefined
    try {
      const existing = contentResponseSchema.parse(await this.request('GET', `/repos/${path}/contents/${DEVCONTAINER_PATH}`, contentResponseSchema, signal))
      sha = existing.sha
    } catch (error) {
      if (!(error instanceof CodespaceError && error.status === 404)) throw error
    }
    await this.putContents(path, {
      message: 'Add SoryCode devcontainer',
      content: Buffer.from(DEVCONTAINER_JSON, 'utf8').toString('base64'),
      ...(sha === undefined ? {} : { sha }),
    }, signal)
  }

  /**
   * Read the devcontainer document currently stored in the repository.
   * @param repository - `owner/name`.
   * @param signal - cancels the round-trip.
   * @returns the file content, or undefined while the repository holds none.
   */
  async readDevcontainer(repository: string, signal?: AbortSignal): Promise<string | undefined> {
    const path = repositoryPath(repository)
    try {
      const record = contentResponseSchema.parse(await this.request('GET', `/repos/${path}/contents/${DEVCONTAINER_PATH}`, contentResponseSchema, signal))
      return Buffer.from(record.content, 'base64').toString('utf8')
    } catch (error) {
      if (error instanceof CodespaceError && error.status === 404) return undefined
      throw error
    }
  }

  private async putContents(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const token = await this.token(signal)
    const response = await this.fetch('PUT', `/repos/${path}/contents/${DEVCONTAINER_PATH}`, token, signal, body)
    if (!response.ok) throw this.error(response.status, await response.text())
  }

  private async token(signal?: AbortSignal): Promise<string> {
    const token = await this.ctx.github.resolveToken(signal)
    if (token === undefined) {
      throw new CodespaceError(
        'no GitHub credential is stored; authorize GitHub with the Codespaces permission first',
        'CODESPACE_AUTH')
    }
    return token
  }

  private async request<T>(method: string, path: string, result: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const token = await this.token(signal)
    const response = await this.fetch(method, path, token, signal)
    if (!response.ok) throw this.error(response.status, await response.text())
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text)
    } catch {
      throw new CodespaceError(`GitHub returned a non-JSON response (HTTP ${response.status})`, 'CODESPACE_API', response.status)
    }
    const validated = result.safeParse(parsed)
    if (!validated.success) throw new CodespaceError('GitHub returned an invalid codespaces record', 'CODESPACE_API', response.status)
    return validated.data
  }

  private async post<T>(path: string, body: Record<string, unknown>, result: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const token = await this.token(signal)
    const response = await this.fetch('POST', path, token, signal, body)
    if (!response.ok) throw this.error(response.status, await response.text())
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text)
    } catch {
      throw new CodespaceError(`GitHub returned a non-JSON response (HTTP ${response.status})`, 'CODESPACE_API', response.status)
    }
    const validated = result.safeParse(parsed)
    if (!validated.success) throw new CodespaceError('GitHub returned an invalid codespace record', 'CODESPACE_API', response.status)
    return validated.data
  }

  private async fetch(
    method: string,
    path: string,
    token: string,
    signal?: AbortSignal,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const bounded = signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    return await fetch(`${this.config.apiBase}${path}`, {
      method,
      redirect: 'error',
      headers: {
        'user-agent': userAgent(),
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2026-03-10',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: bounded,
    })
  }

  private error(status: number, body: string): CodespaceError {
    let message = `GitHub Codespaces request failed (HTTP ${status})`
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed === 'object' && parsed !== null && 'message' in parsed && typeof parsed.message === 'string') {
        message = parsed.message
      }
    } catch {
      // A non-JSON body keeps the generic diagnostic.
    }
    switch (status) {
      case 401:
        return new CodespaceError('GitHub rejected the stored credential; reconnect GitHub with the Codespaces permission', 'CODESPACE_AUTH', status)
      case 403:
        return new CodespaceError(
          /quota|billing|upgrade/i.test(message)
            ? 'the GitHub account exceeded its Codespaces quota; raise the quota or wait for the billing cycle'
            : 'the GitHub account lacks the Codespaces permission; reconnect GitHub with the required scopes',
          /quota|billing|upgrade/i.test(message) ? 'CODESPACE_QUOTA' : 'CODESPACE_FORBIDDEN', status)
      case 404:
        return new CodespaceError('no codespace with that name exists for the connected GitHub account', 'CODESPACE_NOT_FOUND', status)
      case 409:
        return new CodespaceError('the codespace is in a conflicting state; wait for the pending operation to finish', 'CODESPACE_UNAVAILABLE', status)
      case 422:
        return new CodespaceError(message, 'CODESPACE_INVALID_REPOSITORY', status)
      default:
        return new CodespaceError(message, 'CODESPACE_API', status)
    }
  }
}

export const name = 'codespaces'

export const inject = ['github'] as const

export const Config: schema<Config> = schema.object({
  apiBase: schema.string(),
  requestTimeoutMs: schema.number(),
})

/**
 * Mount the Codespaces lifecycle service.
 * @param ctx - the host context.
 * @param config - deployment-owned API settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(CodespaceService, config)
}

export default CodespaceService

function repositoryPath(repository: string): string {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new CodespaceError(
      `repository "${repository}" must be "owner/name"`,
      'CODESPACE_INVALID_REPOSITORY')
  }
  return repository.split('/').map(encodeURIComponent).join('/')
}
