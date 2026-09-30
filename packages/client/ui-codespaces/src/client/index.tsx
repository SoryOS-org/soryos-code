/**
 * Codespaces environment panel (browser half): the configuration form, the
 * lifecycle controls, and the GitHub authorization flow bridge over the
 * `ctx.remote.codespaces` namespace. Every operation is server-side; the panel
 * never sees a GitHub token.
 * @module @deepseek-ai/dsh-client-ui-codespaces/client
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  AuthorizationNoticeFrame,
  AuthorizationPromptFrame,
  AuthorizationSettlementFrame,
  CodespacesEnvironmentConfig,
  CodespacesStatusValue,
} from '@deepseek-ai/dsh-api-codespaces-controller/types'
import type { BranchSummary, MachineSummary, RepositorySummary } from '@deepseek-ai/dsh-codespaces/types'

export const inject = ['remote', 'remote.codespaces'] as const

/** The Remote namespace surface the panel consumes. */
interface CodespacesRemote {
  getStatus(request: { workspaceId: WorkspaceId }): Promise<CodespacesStatusValue>
  listRepositories(): Promise<RepositorySummary[]>
  listBranches(repository: string): Promise<BranchSummary[]>
  listMachines(repository: string): Promise<MachineSummary[]>
  configure(request: { workspaceId: WorkspaceId; config: CodespacesEnvironmentConfig }): Promise<unknown>
  connect(request: { workspaceId: WorkspaceId }): Promise<{ url: string }>
  reconnect(request: { workspaceId: WorkspaceId }): Promise<{ url: string }>
  disconnect(request: { workspaceId: WorkspaceId }): Promise<void>
  stop(request: { workspaceId: WorkspaceId }): Promise<void>
  remove(request: { workspaceId: WorkspaceId }): Promise<void>
  followAuthorization(
    request: { method?: string },
    signal: AbortSignal,
  ): AsyncIterable<AuthorizationNoticeFrame | AuthorizationPromptFrame | AuthorizationSettlementFrame>
  answerAuthorization(request: { promptId: string; answer: string }): Promise<void>
}

const CodespacesRemoteContext = createContext<CodespacesRemote | undefined>(undefined)

/**
 * Provide the Codespaces Remote namespace to the panel tree.
 * @param ctx - the client plugin context.
 * @param children - the panel tree.
 * @returns the provider element.
 */
export function CodespacesPanelProvider({
  ctx,
  children,
}: {
  ctx: Context
  children: React.ReactNode
}) {
  const remote = ctx.remote.codespaces as unknown as CodespacesRemote
  return <CodespacesRemoteContext.Provider value={remote}>{children}</CodespacesRemoteContext.Provider>
}

/** The panel's view state, derived from the server status projection. */
interface PanelState {
  status: CodespacesStatusValue | undefined
  branches: BranchSummary[]
  machines: MachineSummary[]
  busy: boolean
  error: string | undefined
}

/** The authorization flow view state. */
interface AuthorizationState {
  notices: AuthorizationNoticeFrame[]
  prompt: AuthorizationPromptFrame | undefined
  settled: boolean | undefined
}

/**
 * The Codespaces environment panel for one workspace.
 * @param workspaceId - the workspace whose environment is configured.
 * @returns the panel element.
 */
export function CodespacesPanel({ workspaceId }: { workspaceId: WorkspaceId }) {
  const remote = useContext(CodespacesRemoteContext)
  const [state, setState] = useState<PanelState>({ status: undefined, branches: [], machines: [], busy: false, error: undefined })
  const [config, setConfig] = useState<CodespacesEnvironmentConfig>({ repository: '' })
  const [authFlow, setAuthFlow] = useState<AuthorizationState>({ notices: [], prompt: undefined, settled: undefined })
  const [promptAnswer, setPromptAnswer] = useState('')

  const refresh = useCallback(async () => {
    const status = await remote?.getStatus({ workspaceId })
    setState(current => ({ ...current, status, error: undefined }))
    return status
  }, [remote, workspaceId])

  useEffect(() => {
    if (remote === undefined) return
    void refresh().catch((error: unknown) => {
      setState(current => ({ ...current, error: error instanceof Error ? error.message : String(error) }))
    })
  }, [remote, refresh])

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setState(current => ({ ...current, busy: true, error: undefined }))
    try {
      await operation()
      await refresh()
    } catch (error) {
      setState(current => ({ ...current, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setState(current => ({ ...current, busy: false }))
    }
  }, [refresh])

  const pickRepository = useCallback(async (repository: string) => {
    setConfig(current => ({ ...current, repository }))
    if (remote === undefined) return
    const [branches, machines] = await Promise.all([
      remote.listBranches(repository),
      remote.listMachines(repository),
    ])
    setState(current => ({ ...current, branches, machines }))
  }, [remote])

  const configure = useCallback(async () => {
    if (remote === undefined) return
    await run(async () => {
      await remote.configure({ workspaceId, config })
    })
  }, [remote, run, workspaceId, config])

  const connect = useCallback(async () => {
    if (remote === undefined) return
    await run(async () => {
      const target = await remote.connect({ workspaceId })
      window.open(target.url, '_blank', 'noopener')
    })
  }, [remote, run, workspaceId])

  const beginAuthorization = useCallback(async (method?: string) => {
    if (remote === undefined) return
    setAuthFlow({ notices: [], prompt: undefined, settled: undefined })
    const stream = remote.followAuthorization(
      method === undefined ? {} : { method },
      new AbortController().signal,
    ) as AsyncGenerator<AuthorizationNoticeFrame | AuthorizationPromptFrame | AuthorizationSettlementFrame>
    for await (const frame of stream) {
      setAuthFlow((current) => {
        if (frame.kind === 'notice') return { ...current, notices: [...current.notices, frame] }
        if (frame.kind === 'prompt') return { ...current, prompt: frame }
        return { ...current, settled: frame.authorized }
      })
    }
  }, [remote])

  const answerPrompt = useCallback(async (answer: string) => {
    const prompt = authFlow.prompt
    if (prompt === undefined || remote === undefined) return
    await remote.answerAuthorization({ promptId: prompt.promptId, answer })
  }, [remote, authFlow.prompt])

  if (remote === undefined) return null

  const status = state.status
  const lifecycle = status?.lifecycle ?? 'none'

  return (
    <div className="codespaces-panel">
      <h3>Environment</h3>
      {state.error !== undefined && <p role="alert">{state.error}</p>}
      {status?.configured === true && (
        <dl>
          <dt>Repository</dt><dd>{status.repository}</dd>
          {status.branch !== undefined && <><dt>Branch</dt><dd>{status.branch}</dd></>}
          {status.machine !== undefined && <><dt>Machine</dt><dd>{status.machine}</dd></>}
          {status.codespaceName !== undefined && <><dt>Codespace</dt><dd>{status.codespaceName}</dd></>}
          {status.codespaceState !== undefined && <><dt>State</dt><dd>{status.codespaceState}</dd></>}
          <dt>Lifecycle</dt><dd>{lifecycle}</dd>
          {status.workspaceUrl !== undefined && <><dt>Workspace URL</dt><dd>{status.workspaceUrl}</dd></>}
        </dl>
      )}
      {status?.configured !== true && (
        <form onSubmit={(event) => { event.preventDefault(); void configure() }}>
          <label>
            Repository
            <input
              type="text"
              value={config.repository}
              placeholder="owner/repository"
              onChange={(event) => { void pickRepository(event.target.value) }}
            />
          </label>
          <label>
            Branch
            <input
              type="text"
              value={config.branch ?? ''}
              placeholder="main"
              onChange={(event) => { setConfig(current => ({ ...current, branch: event.target.value })) }}
            />
          </label>
          <label>
            Machine
            <select
              value={config.machine ?? ''}
              onChange={(event) => {
                const value = event.target.value
                setConfig(current => ({ ...current, ...(value === '' ? {} : { machine: value }) }))
              }}
            >
              <option value="">Default</option>
              {state.machines.map(machine => <option key={machine.name} value={machine.name}>{machine.displayName}</option>)}
            </select>
          </label>
          <button type="submit" disabled={state.busy || config.repository === ''}>Configure</button>
        </form>
      )}
      {status?.configured === true && (
        <div>
          <button onClick={() => { void connect() }} disabled={state.busy || lifecycle === 'connected'}>Connect</button>
          <button onClick={() => { void run(() => remote.disconnect({ workspaceId })) }} disabled={state.busy || lifecycle !== 'connected'}>Disconnect</button>
          <button onClick={() => { void run(() => remote.reconnect({ workspaceId })) }} disabled={state.busy}>Reconnect</button>
          <button onClick={() => { void run(() => remote.stop({ workspaceId })) }} disabled={state.busy || lifecycle === 'none'}>Stop</button>
          <button onClick={() => { void run(() => remote.remove({ workspaceId })) }} disabled={state.busy}>Delete</button>
        </div>
      )}
      {status?.authorization.configured !== true && (
        <div>
          <h4>GitHub authorization</h4>
          {status?.authorization.methods.map(method => (
            <button key={method.id} onClick={() => void beginAuthorization(method.id)} disabled={state.busy}>{method.label}</button>
          ))}
          {authFlow.notices.map((notice, index) => (
            <p key={index}>
              {notice.message}
              {notice.url !== undefined && <a href={notice.url} target="_blank" rel="noreferrer">{notice.code ?? notice.url}</a>}
            </p>
          ))}
          {authFlow.prompt !== undefined && (
            <form onSubmit={(event) => { event.preventDefault(); void answerPrompt(promptAnswer) }}>
              <label>
                {authFlow.prompt.message}
                <input
                  type={authFlow.prompt.secret ? 'password' : 'text'}
                  value={promptAnswer}
                  onChange={(event) => { setPromptAnswer(event.target.value) }}
                />
              </label>
              <button type="submit">Submit</button>
            </form>
          )}
          {authFlow.settled === true ? <p>GitHub authorized.</p> : null}
        </div>
      )}
    </div>
  )
}

export default CodespacesPanel
