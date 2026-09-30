import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, CodespaceConnection, CodespaceConnectionError } from '../src/index.ts'
import type { CodespacesWorkspaceState } from '@deepseek-ai/dsh-codespaces-registry'
import type { Codespace } from '@deepseek-ai/dsh-codespaces'

const WORKSPACE = 'workspace-1' as never

const STATE: CodespacesWorkspaceState = {
  kind: 'codespaces',
  repository: 'octocat/hello-world',
  branch: 'main',
  machine: 'basicLinux32gb',
  codespaceName: 'monalisa-hot-potato-vrpqrxxrx7x2rxx',
}

const CODESPACE: Codespace = {
  id: 1,
  name: 'monalisa-hot-potato-vrpqrxxrx7x2rxx',
  displayName: 'sorycode',
  state: 'available',
  repository: { id: 42, fullName: 'octocat/hello-world', name: 'hello-world', owner: 'octocat', defaultBranch: 'main' },
  machine: 'basicLinux32gb',
  createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T10:05:00Z',
  url: 'https://github.com/codespaces/monalisa-hot-potato-vrpqrxxrx7x2rxx',
  apiUrl: 'https://api.github.com/user/codespaces/monalisa-hot-potato-vrpqrxxrx7x2rxx',
}

class GithubStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'github')
  }

  async resolveToken(): Promise<string | undefined> {
    return 'gho_testtoken'
  }
}

class CodespacesStub extends Service {
  calls: { method: string; args: unknown[] }[] = []
  codespace: Codespace = CODESPACE
  failGet: number | undefined

  constructor(ctx: Context) {
    super(ctx, 'codespaces')
  }

  async create(): Promise<Codespace> {
    this.calls.push({ method: 'create', args: [] })
    return this.codespace
  }

  async get(name: string): Promise<Codespace> {
    this.calls.push({ method: 'get', args: [name] })
    if (this.failGet !== undefined) {
      const status = this.failGet
      this.failGet = undefined
      const error = new Error('Not Found') as Error & { status: number }
      error.status = status
      throw error
    }
    return this.codespace
  }

  async list(): Promise<Codespace[]> {
    this.calls.push({ method: 'list', args: [] })
    return [this.codespace]
  }

  async start(name: string): Promise<Codespace> {
    this.calls.push({ method: 'start', args: [name] })
    return this.codespace
  }

  async stop(name: string): Promise<Codespace> {
    this.calls.push({ method: 'stop', args: [name] })
    return { ...this.codespace, state: 'shutdown' }
  }

  async remove(name: string): Promise<void> {
    this.calls.push({ method: 'remove', args: [name] })
  }

  async writeDevcontainer(): Promise<void> {
    this.calls.push({ method: 'writeDevcontainer', args: [] })
  }
}

class RegistryStub extends Service {
  state: CodespacesWorkspaceState | undefined = { ...STATE }

  constructor(ctx: Context) {
    super(ctx, 'codespacesRegistry')
  }

  async read(): Promise<CodespacesWorkspaceState | undefined> {
    return this.state
  }

  async save(_workspaceId: unknown, state: CodespacesWorkspaceState): Promise<void> {
    this.state = state
  }

  async remove(): Promise<void> {
    this.state = undefined
  }
}

type ConnectionMock = Omit<CodespaceConnection, 'runGh' | 'runScp' | 'runSsh' | 'openSshConnection' | 'localHelperHash' | 'startHarness'> & {
  runGh: ReturnType<typeof vi.fn>
  runScp: ReturnType<typeof vi.fn>
  runSsh: ReturnType<typeof vi.fn>
  openSshConnection: ReturnType<typeof vi.fn>
  localHelperHash: ReturnType<typeof vi.fn>
  startHarness: ReturnType<typeof vi.fn>
}

async function harness(options: { failGet?: number } = {}) {
  const ctx = new Context()
  const fibers = [await ctx.plugin(GithubStub), await ctx.plugin(CodespacesStub), await ctx.plugin(RegistryStub), await ctx.plugin(apply)]
  const codespaces = ctx.codespaces as unknown as CodespacesStub
  const registry = ctx.codespacesRegistry as unknown as RegistryStub
  codespaces.failGet = options.failGet
  const connection = ctx.codespacesConnection as unknown as ConnectionMock
  return { ctx, connection, codespaces, registry, dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

function mockTransport(connection: ConnectionMock, host = 'codespace-alias') {
  connection.runGh = vi.fn(async (args: string[]) => {
    if (args.includes('--config')) return `Host ${host}\n  HostName example.com\n  User node\n`
    if (args.includes('ports')) return JSON.stringify([{ number: 3080, remoteUrl: `https://${STATE.codespaceName}-3080.app.github.dev` }])
    return ''
  })
  connection.runScp = vi.fn(async () => {})
  connection.runSsh = vi.fn(async (_host: string, command: string) => {
    if (command === 'which node') return '/usr/local/bin/node'
    if (command === 'pwd') return '/workspaces/hello-world'
    if (command.startsWith('sha256sum')) return 'abc123'
    if (command.startsWith('echo $GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN')) return 'app.github.dev'
    return ''
  })
  connection.localHelperHash = vi.fn(async () => 'abc123')
  connection.openSshConnection = vi.fn(async () => ({ dispose: async () => {}, ready: Promise.resolve({}) }))
  connection.startHarness = vi.fn(async () => ({ port: 3080, token: 'launch-token' }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CodespaceConnection', () => {
  it('connects an already-provisioned codespace end to end', async () => {
    const { ctx, connection } = await harness()
    mockTransport(connection)

    const target = await ctx.codespacesConnection.connect(WORKSPACE)

    expect(target.environment).toBe('codespaces')
    expect(target.url.toString()).toBe('https://monalisa-hot-potato-vrpqrxxrx7x2rxx-3080.app.github.dev/')
    expect(ctx.codespacesConnection.status).toBe('connected')
    expect(connection.runGh.mock.calls[0]?.[0]).toEqual(['codespace', 'ssh', '--config'])
    expect(connection.runScp).toHaveBeenCalled()
  })

  it('provisions a codespace when the stored state names none', async () => {
    const { ctx, connection, registry } = await harness()
    registry.state = { kind: 'codespaces', repository: 'octocat/hello-world' }
    mockTransport(connection)

    const target = await ctx.codespacesConnection.connect(WORKSPACE)

    expect(target.url.toString()).toContain('monalisa-hot-potato-vrpqrxxrx7x2rxx')
    expect(registry.state?.codespaceName).toBe(STATE.codespaceName)
  })

  it('refuses a workspace with no stored environment configuration', async () => {
    const { ctx, registry } = await harness()
    registry.state = undefined

    await expect(ctx.codespacesConnection.connect(WORKSPACE))
      .rejects.toMatchObject({ name: 'CodespaceConnectionError', code: 'NO_ENVIRONMENT_CONFIGURED' })
  })

  it('reprovisions when GitHub reports the codespace deleted', async () => {
    const { ctx, connection, registry } = await harness({ failGet: 404 })
    mockTransport(connection)

    await ctx.codespacesConnection.connect(WORKSPACE)

    expect(registry.state?.codespaceName).toBe(STATE.codespaceName)
  })

  it('reconnects without recreating a live codespace', async () => {
    const { ctx, connection, registry } = await harness()
    mockTransport(connection)
    await ctx.codespacesConnection.connect(WORKSPACE)
    const codesBefore = registry.state

    const target = await ctx.codespacesConnection.reconnect(WORKSPACE)

    expect(target.url.toString()).toContain('monalisa-hot-potato-vrpqrxxrx7x2rxx')
    expect(registry.state).toStrictEqual(codesBefore)
  })

  it('recreates the environment after a reconnect finds the codespace deleted', async () => {
    const { ctx, connection, registry } = await harness()
    mockTransport(connection)
    await ctx.codespacesConnection.connect(WORKSPACE)
    registry.state = { ...STATE }
    connection.runGh = vi.fn(async (args: string[]) => {
      if (args.includes('--config')) return 'Host codespace-alias\n'
      return ''
    })
    const codespaces = ctx.codespaces as unknown as CodespacesStub
    codespaces.failGet = 404

    await ctx.codespacesConnection.reconnect(WORKSPACE)

    expect(codespaces.calls.some(call => call.method === 'create')).toBe(true)
  })

  it('disconnects without touching the stored state', async () => {
    const { ctx, connection, registry } = await harness()
    mockTransport(connection)
    await ctx.codespacesConnection.connect(WORKSPACE)

    await ctx.codespacesConnection.disconnect()

    expect(ctx.codespacesConnection.status).toBe('stopped')
    expect(registry.state?.codespaceName).toBe(STATE.codespaceName)
  })

  it('deletes the environment and clears the stored state', async () => {
    const { ctx, connection, registry } = await harness()
    mockTransport(connection)
    await ctx.codespacesConnection.connect(WORKSPACE)

    await ctx.codespacesConnection.deleteEnvironment(WORKSPACE)

    expect(registry.state).toBeUndefined()
    expect(ctx.codespacesConnection.status).toBe('none')
    expect(ctx.codespacesConnection.workspaceTarget).toBeUndefined()
  })

  it('stops the codespace and clears the runtime URL', async () => {
    const { ctx, connection, registry } = await harness()
    mockTransport(connection)
    await ctx.codespacesConnection.connect(WORKSPACE)

    await ctx.codespacesConnection.stopCodespace(WORKSPACE)

    expect(registry.state?.workspaceUrl).toBeUndefined()
    expect(ctx.codespacesConnection.status).toBe('stopped')
  })

  it('exposes the error class for consumers', () => {
    expect(new CodespaceConnectionError('x', 'TRANSPORT')).toBeInstanceOf(CodespaceConnectionError)
  })
})
