import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { CodespacesWorkspaceState } from '@deepseek-ai/dsh-codespaces-registry'
import type { AuthorizationNoticeFrame, AuthorizationPromptFrame, AuthorizationSettlementFrame } from '../src/types.ts'
import type { RemoteWorkspaceTarget } from '@deepseek-ai/dsh-codespaces-connection'

const WORKSPACE = 'workspace-1' as never

class GithubStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'github')
  }

  async resolveToken(): Promise<string | undefined> {
    return 'gho_testtoken'
  }

  async describe() {
    return {
      key: 'github/codespaces' as never,
      label: 'GitHub',
      methods: [{ id: 'oauth-device', label: 'GitHub account (browser)' }, { id: 'pat', label: 'Personal access token' }],
      configured: true,
      inFlight: false,
    }
  }

  async beginAuthorization(): Promise<{ status: 'authorized' }> {
    return { status: 'authorized' }
  }

  cancelAuthorization(): void {}
}

class CodespacesStub extends Service {
  codespace = {
    id: 1, name: 'cs-1', displayName: 'sorycode', state: 'available',
    repository: { id: 42, fullName: 'octocat/hello-world', name: 'hello-world', owner: 'octocat', defaultBranch: 'main' },
    machine: 'basicLinux32gb',
    createdAt: '', updatedAt: '', url: '', apiUrl: '',
  }

  constructor(ctx: Context) {
    super(ctx, 'codespaces')
  }

  async getRepository(repository: string) {
    if (repository !== 'octocat/hello-world') {
      const error = new Error('Not Found') as Error & { status: number }
      error.status = 404
      throw error
    }
    return this.codespace.repository
  }

  async getBranch(_repository: string, ref: string) {
    if (ref !== 'main') {
      const error = new Error('Not Found') as Error & { status: number }
      error.status = 404
      throw error
    }
    return { name: ref, sha: 'abc' }
  }

  async listRepositories() {
    return [{ fullName: 'octocat/hello-world', name: 'hello-world', owner: 'octocat', isPrivate: false, defaultBranch: 'main' }]
  }

  async listBranches() {
    return [{ name: 'main', sha: 'abc' }]
  }

  async listMachines() {
    return [{ name: 'basicLinux32gb', displayName: 'Basic' }]
  }

  async get() {
    return this.codespace
  }
}

class RegistryStub extends Service {
  state: CodespacesWorkspaceState | undefined

  constructor(ctx: Context) {
    super(ctx, 'codespacesRegistry')
  }

  async read(): Promise<CodespacesWorkspaceState | undefined> {
    return this.state
  }

  async save(_id: unknown, state: CodespacesWorkspaceState): Promise<void> {
    this.state = state
  }

  async remove(): Promise<void> {
    this.state = undefined
  }
}

class ConnectionStub extends Service {
  status: 'none' | 'connected' | 'stopped' = 'none'
  target: RemoteWorkspaceTarget | undefined

  constructor(ctx: Context) {
    super(ctx, 'codespacesConnection')
  }

  async connect(workspaceId: string): Promise<RemoteWorkspaceTarget> {
    this.status = 'connected'
    this.target = { url: new URL('https://cs-1-3080.app.github.dev/'), workspaceId: workspaceId as never, environment: 'codespaces' }
    return this.target
  }

  async reconnect(workspaceId: string): Promise<RemoteWorkspaceTarget> {
    return await this.connect(workspaceId)
  }

  async disconnect(): Promise<void> {
    this.status = 'none'
  }

  async stopCodespace(_workspaceId: string): Promise<void> {
    this.status = 'stopped'
  }

  async deleteEnvironment(_workspaceId: string): Promise<void> {
    this.status = 'none'
    this.target = undefined
    await (this.ctx.codespacesRegistry as unknown as RegistryStub).remove()
  }
}

async function harness() {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(GithubStub),
    await ctx.plugin(CodespacesStub),
    await ctx.plugin(RegistryStub),
    await ctx.plugin(ConnectionStub),
    await ctx.plugin(apply),
  ]
  return { ctx, dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

describe('CodespacesController', () => {
  it('lists repositories, branches, and machines for the pickers', async () => {
    const { ctx } = await harness()

    expect(await ctx.codespacesController.listRepositories()).toHaveLength(1)
    expect(await ctx.codespacesController.listBranches('octocat/hello-world')).toEqual([{ name: 'main', sha: 'abc' }])
    expect(await ctx.codespacesController.listMachines('octocat/hello-world')).toEqual([{ name: 'basicLinux32gb', displayName: 'Basic' }])
  })

  it('configures the environment after validating repository and branch', async () => {
    const { ctx } = await harness()

    const configured = await ctx.codespacesController.configure({
      workspaceId: WORKSPACE,
      config: { repository: 'octocat/hello-world', branch: 'main', machine: 'basicLinux32gb' },
    })

    expect(configured.repository).toBe('octocat/hello-world')
    expect(configured.branch).toBe('main')
    expect(configured.machine).toBe('basicLinux32gb')
  })

  it('rejects an invalid repository before persisting', async () => {
    const { ctx } = await harness()

    await expect(ctx.codespacesController.configure({
      workspaceId: WORKSPACE,
      config: { repository: 'octocat/missing' },
    })).rejects.toThrow()
  })

  it('rejects an invalid branch before persisting', async () => {
    const { ctx } = await harness()

    await expect(ctx.codespacesController.configure({
      workspaceId: WORKSPACE,
      config: { repository: 'octocat/hello-world', branch: 'nope' },
    })).rejects.toThrow()
  })

  it('reads the status projection', async () => {
    const { ctx } = await harness()
    const registry = ctx.codespacesRegistry as unknown as RegistryStub
    registry.state = { kind: 'codespaces', repository: 'octocat/hello-world', codespaceName: 'cs-1' }

    const status = await ctx.codespacesController.getStatus({ workspaceId: WORKSPACE })

    expect(status.configured).toBe(true)
    expect(status.repository).toBe('octocat/hello-world')
    expect(status.codespaceName).toBe('cs-1')
    expect(status.codespaceState).toBe('available')
    expect(status.authorization.configured).toBe(true)
  })

  it('connects and returns the remote workspace URL', async () => {
    const { ctx } = await harness()
    const registry = ctx.codespacesRegistry as unknown as RegistryStub
    registry.state = { kind: 'codespaces', repository: 'octocat/hello-world', codespaceName: 'cs-1' }

    const connected = await ctx.codespacesController.connect({ workspaceId: WORKSPACE })

    expect(connected.url).toBe('https://cs-1-3080.app.github.dev/')
    expect(connected.lifecycle).toBe('connected')
  })

  it('reconnects, disconnects, stops, and removes', async () => {
    const { ctx } = await harness()
    const registry = ctx.codespacesRegistry as unknown as RegistryStub
    registry.state = { kind: 'codespaces', repository: 'octocat/hello-world', codespaceName: 'cs-1' }
    const connection = ctx.codespacesConnection as unknown as ConnectionStub

    await ctx.codespacesController.connect({ workspaceId: WORKSPACE })
    expect((await ctx.codespacesController.reconnect({ workspaceId: WORKSPACE })).lifecycle).toBe('connected')
    await ctx.codespacesController.disconnect({ workspaceId: WORKSPACE })
    expect(connection.status).toBe('none')
    await ctx.codespacesController.stop({ workspaceId: WORKSPACE })
    expect(connection.status).toBe('stopped')
    await ctx.codespacesController.remove({ workspaceId: WORKSPACE })
    expect(registry.state).toBeUndefined()
  })

  it('exposes the GitHub authorization facts without a token', async () => {
    const { ctx } = await harness()

    const authorization = await ctx.codespacesController.getAuthorization()

    expect(authorization.configured).toBe(true)
    expect(authorization.methods.map(method => method.id)).toEqual(['oauth-device', 'pat'])
  })

  it('streams the authorization settlement', async () => {
    const { ctx } = await harness()

    const frames: { kind: string }[] = []
    for await (const frame of ctx.codespacesController.followAuthorization({ method: 'pat' }, new AbortController().signal)) {
      frames.push(frame)
    }

    expect(frames.map(frame => frame.kind)).toContain('settlement')
    expect(frames[frames.length - 1]).toMatchObject({ kind: 'settlement', authorized: true })
  })

  it('answers a pending authorization prompt', async () => {
    const { ctx } = await harness()
    const github = ctx.github as unknown as GithubStub
    const promptPromise = new Promise<void>((resolve) => {
      github.beginAuthorization = (async (interaction: { prompt: (p: { message: string; kind: string }) => Promise<string> }) => {
        const answer = await interaction.prompt({ message: 'Paste a token', kind: 'secret' })
        expect(answer).toBe('ghp_answered')
        resolve()
        return { status: 'authorized' as const }
      }) as typeof github.beginAuthorization
    })

    const stream = ctx.codespacesController.followAuthorization({ method: 'pat' }, new AbortController().signal) as AsyncGenerator<AuthorizationNoticeFrame | AuthorizationPromptFrame | AuthorizationSettlementFrame>
    const first = await stream.next()
    expect(first.value).toMatchObject({ kind: 'prompt', secret: true })
    await ctx.codespacesController.answerAuthorization({ promptId: (first.value as { promptId: string }).promptId, answer: 'ghp_answered' })
    await promptPromise
  })
})
