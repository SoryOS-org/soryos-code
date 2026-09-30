/**
 * Codespaces environment Remote owner (`ctx.remote.codespaces`): the browser
 * surface over the Codespaces lifecycle — repository/branch/machine pickers,
 * environment configuration, connect/disconnect/reconnect/stop/remove, and
 * the GitHub authorization flow bridge. Every operation is server-side; the
 * GitHub token never crosses this namespace.
 * @module @deepseek-ai/dsh-api-codespaces-controller
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-github-auth'
import type {} from '@deepseek-ai/dsh-codespaces-connection'
import type { AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import type { BranchSummary, MachineSummary, RepositorySummary } from '@deepseek-ai/dsh-codespaces'
import type { CodespacesWorkspaceState } from '@deepseek-ai/dsh-codespaces-registry'
import type {
  AuthorizationNoticeFrame,
  AuthorizationPromptFrame,
  AuthorizationSettlementFrame,
  CodespacesAnswerAuthorizationRequest,
  CodespacesAuthorizationValue,
  CodespacesBeginAuthorizationRequest,
  CodespacesConfigureRequest,
  CodespacesConfigureValue,
  CodespacesConnectValue,
  CodespacesStatusValue,
  CodespacesWorkspaceRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Codespaces environment Remote namespace owner. */
    codespacesController: CodespacesController
  }
}

/** One pending authorization prompt and its answer path. */
interface PendingPrompt {
  readonly promptId: string
  readonly prompt: AuthorizationPrompt
  readonly resolve: (answer: string) => void
}

/** The interaction surface bridging one authorization attempt to the browser. */
class AuthorizationBridge implements AuthorizationInteraction {
  private prompts = new Map<string, PendingPrompt>()
  private notices: AuthorizationNotice[] = []

  notify(notice: AuthorizationNotice): void {
    this.notices.push(notice)
  }

  prompt(prompt: AuthorizationPrompt): Promise<string> {
    const promptId = randomUUID()
    return new Promise<string>((resolve) => {
      this.prompts.set(promptId, { promptId, prompt, resolve })
    })
  }

  /** Drain the notices accumulated since the last drain. */
  drainNotices(): AuthorizationNotice[] {
    const drained = this.notices
    this.notices = []
    return drained
  }

  /** The oldest unanswered prompt, if any. */
  pendingPrompt(): PendingPrompt | undefined {
    return this.prompts.values().next().value
  }

  /** Answer one pending prompt. */
  answer(promptId: string, answer: string): void {
    const pending = this.prompts.get(promptId)
    if (pending === undefined) return
    this.prompts.delete(promptId)
    pending.resolve(answer)
  }
}

/** Host service backing the generated `ctx.remote.codespaces` namespace. */
export class CodespacesController extends TypertRemoteService {
  static inject = ['github', 'codespaces', 'codespacesRegistry', 'codespacesConnection']

  private bridge: AuthorizationBridge | undefined

  constructor(ctx: Context) {
    super(ctx, 'codespacesController', { namespace: 'codespaces' })
  }

  /**
   * List repositories the connected GitHub account can create codespaces in.
   * @returns repositories with their default branch.
   */
  @Remote('listRepositories')
  async listRepositories(): Promise<RepositorySummary[]> {
    return await this.ctx.codespaces.listRepositories()
  }

  /**
   * List branches of one repository.
   * @param repository - `owner/name`.
   * @returns branch names with their head SHAs.
   */
  @Remote('listBranches')
  async listBranches(repository: string): Promise<BranchSummary[]> {
    return await this.ctx.codespaces.listBranches(repository)
  }

  /**
   * List machine types available for codespaces in one repository.
   * @param repository - `owner/name`.
   * @returns machine names with display labels.
   */
  @Remote('listMachines')
  async listMachines(repository: string): Promise<MachineSummary[]> {
    return await this.ctx.codespaces.listMachines(repository)
  }

  /**
   * Store the Codespaces environment configuration for one workspace. The
   * configuration is validated against GitHub (repository exists, branch
   * exists) before it is persisted.
   * @param request - the workspace and its configuration.
   * @returns the stored configuration.
   */
  @Remote('configure')
  async configure(request: CodespacesConfigureRequest): Promise<CodespacesConfigureValue> {
    const repository = await this.ctx.codespaces.getRepository(request.config.repository)
    const branch = request.config.branch ?? repository.defaultBranch
    await this.ctx.codespaces.getBranch(request.config.repository, branch)
    const state: CodespacesWorkspaceState = {
      kind: 'codespaces',
      repository: request.config.repository,
      ...(request.config.branch === undefined ? {} : { branch: request.config.branch }),
      ...(request.config.machine === undefined ? {} : { machine: request.config.machine }),
      ...(request.config.idleTimeoutMinutes === undefined ? {} : { idleTimeoutMinutes: request.config.idleTimeoutMinutes }),
      ...(request.config.retentionPeriodMinutes === undefined ? {} : { retentionPeriodMinutes: request.config.retentionPeriodMinutes }),
      ...(request.config.location === undefined ? {} : { location: request.config.location }),
      ...(request.config.displayName === undefined ? {} : { displayName: request.config.displayName }),
    }
    await this.ctx.codespacesRegistry.save(request.workspaceId, state)
    return {
      workspaceId: request.workspaceId,
      repository: state.repository,
      ...(state.branch === undefined ? {} : { branch: state.branch }),
      ...(state.machine === undefined ? {} : { machine: state.machine }),
    }
  }

  /**
   * Read the environment status projection for one workspace.
   * @param request - the workspace to read.
   * @returns the lifecycle state, the stored configuration, and the GitHub authorization facts.
   */
  @Remote('getStatus')
  async getStatus(request: CodespacesWorkspaceRequest): Promise<CodespacesStatusValue> {
    const state = await this.ctx.codespacesRegistry.read(request.workspaceId)
    const authorization = await this.ctx.github.describe()
    let codespaceState: string | undefined
    if (state?.codespaceName !== undefined) {
      try {
        codespaceState = (await this.ctx.codespaces.get(state.codespaceName)).state
      } catch {
        codespaceState = undefined
      }
    }
    return {
      lifecycle: this.ctx.codespacesConnection.status,
      configured: state !== undefined,
      ...(state === undefined ? {} : {
        repository: state.repository,
        ...(state.branch === undefined ? {} : { branch: state.branch }),
        ...(state.machine === undefined ? {} : { machine: state.machine }),
        ...(state.codespaceName === undefined ? {} : { codespaceName: state.codespaceName }),
        ...(state.workspaceUrl === undefined ? {} : { workspaceUrl: state.workspaceUrl }),
      }),
      ...(codespaceState === undefined ? {} : { codespaceState }),
      authorization: {
        configured: authorization.configured,
        methods: authorization.methods,
      },
    }
  }

  /**
   * Connect the workspace to its Codespace environment, provisioning it when
   * the stored state names no codespace yet.
   * @param request - the workspace to connect.
   * @returns the remote workspace URL and the resulting lifecycle state.
   */
  @Remote('connect')
  async connect(request: CodespacesWorkspaceRequest): Promise<CodespacesConnectValue> {
    const target = await this.ctx.codespacesConnection.connect(request.workspaceId)
    return { url: target.url.toString(), lifecycle: this.ctx.codespacesConnection.status }
  }

  /**
   * Reconnect after a network loss; the codespace is reused when GitHub still
   * reports it.
   * @param request - the workspace to reconnect.
   * @returns the remote workspace URL and the resulting lifecycle state.
   */
  @Remote('reconnect')
  async reconnect(request: CodespacesWorkspaceRequest): Promise<CodespacesConnectValue> {
    const target = await this.ctx.codespacesConnection.reconnect(request.workspaceId)
    return { url: target.url.toString(), lifecycle: this.ctx.codespacesConnection.status }
  }

  /**
   * Stop the remote harness process and close the SSH connection; the
   * codespace keeps running.
   * @param request - the workspace to disconnect.
   */
  @Remote('disconnect')
  async disconnect(_request: CodespacesWorkspaceRequest): Promise<void> {
    await this.ctx.codespacesConnection.disconnect()
  }

  /**
   * Stop the codespace; the filesystem survives, the processes do not.
   * @param request - the workspace whose codespace should stop.
   */
  @Remote('stop')
  async stop(request: CodespacesWorkspaceRequest): Promise<void> {
    await this.ctx.codespacesConnection.stopCodespace(request.workspaceId)
  }

  /**
   * Delete the codespace and clear the stored environment state. Destructive
   * and irreversible; the UI must confirm before calling.
   * @param request - the workspace whose environment should be deleted.
   */
  @Remote('remove')
  async remove(request: CodespacesWorkspaceRequest): Promise<void> {
    await this.ctx.codespacesConnection.deleteEnvironment(request.workspaceId)
  }

  /**
   * Read the GitHub authorization facts for configuration UIs.
   * @returns presence and method facts — never a token.
   */
  @Remote('getAuthorization')
  async getAuthorization(): Promise<CodespacesAuthorizationValue> {
    const authorization = await this.ctx.github.describe()
    return { configured: authorization.configured, methods: authorization.methods }
  }

  /**
   * Begin one GitHub authorization attempt. The returned stream carries the
   * notices and prompts the flow emits; the browser answers prompts through
   * `answerAuthorization`.
   * @param request - the method to run.
   * @param signal - cancellation of the stream.
   * @returns the notice, prompt, and settlement frames.
   */
  @Remote({ mode: 'stream' })
  followAuthorization(
    request: CodespacesBeginAuthorizationRequest,
    signal: AbortSignal,
  ): AsyncIterable<AuthorizationNoticeFrame | AuthorizationPromptFrame | AuthorizationSettlementFrame> {
    return this.runAuthorization(request, signal)
  }

  /**
   * Answer one pending authorization prompt.
   * @param request - the prompt id and the answer.
   */
  @Remote('answerAuthorization')
  answerAuthorization(request: CodespacesAnswerAuthorizationRequest): Promise<void> {
    this.bridge?.answer(request.promptId, request.answer)
    return Promise.resolve()
  }

  /**
   * Withdraw the running authorization attempt, if any.
   */
  @Remote('cancelAuthorization')
  cancelAuthorization(): Promise<void> {
    this.ctx.github.cancelAuthorization()
    return Promise.resolve()
  }

  private async *runAuthorization(
    request: CodespacesBeginAuthorizationRequest,
    signal: AbortSignal,
  ): AsyncIterable<AuthorizationNoticeFrame | AuthorizationPromptFrame | AuthorizationSettlementFrame> {
    const bridge = new AuthorizationBridge()
    this.bridge = bridge
    let outcome: { status: 'authorized' | 'cancelled' } | undefined
    const running = this.ctx.github.beginAuthorization(bridge, request.method, signal)
    running.then((settled) => { outcome = settled }).catch(() => { outcome = { status: 'cancelled' } })
    try {
      for (;;) {
        signal.throwIfAborted()
        for (const notice of bridge.drainNotices()) {
          yield { kind: 'notice', message: notice.message, ...(notice.url === undefined ? {} : { url: notice.url }), ...(notice.code === undefined ? {} : { code: notice.code }) }
        }
        const pending = bridge.pendingPrompt()
        if (pending !== undefined) {
          yield {
            kind: 'prompt',
            promptId: pending.promptId,
            message: pending.prompt.message,
            secret: pending.prompt.kind === 'secret',
          }
        }
        if (outcome !== undefined) {
          yield { kind: 'settlement', authorized: outcome.status === 'authorized' }
          return
        }
        await new Promise<void>(resolve => setTimeout(resolve, 200))
      }
    } finally {
      if (this.bridge === bridge) this.bridge = undefined
    }
  }
}

export const name = 'codespaces-controller'

export const inject = ['github', 'codespaces', 'codespacesRegistry', 'codespacesConnection'] as const

/**
 * Mount the Codespaces controller.
 * @param ctx - the host context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(CodespacesController)
}

export default CodespacesController
