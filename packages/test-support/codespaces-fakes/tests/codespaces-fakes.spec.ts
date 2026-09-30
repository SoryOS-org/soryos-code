import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeGitHubApi, FakeHarnessRuntime } from '../src/index.ts'
import { apply as applyCodespaces, CodespaceService } from '@deepseek-ai/dsh-codespaces'
import { CodespacesRegistry } from '@deepseek-ai/dsh-codespaces-registry'
import { CodespacesController } from '@deepseek-ai/dsh-api-codespaces-controller'

class GithubStub extends Service {
  constructor(ctx: Context, private readonly token: string | undefined) {
    super(ctx, 'github')
  }

  async resolveToken(): Promise<string | undefined> {
    return this.token
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
}

let githubApi: FakeGitHubApi | undefined
let harness: FakeHarnessRuntime | undefined

afterEach(async () => {
  await githubApi?.stop()
  githubApi = undefined
  await harness?.stop()
  harness = undefined
})

describe('FakeGitHubApi integration', () => {
  it('serves the full codespaces lifecycle', async () => {
    githubApi = await FakeGitHubApi.start()
    const ctx = new Context()
    await ctx.plugin(GithubStub, 'gho_test')
    await ctx.plugin(applyCodespaces, { apiBase: githubApi.baseUrl })

    const created = await ctx.codespaces.create({ repository: 'octocat/hello-world', branch: 'main' })
    expect(created.name).toMatch(/^fake-codespace-\d+$/)
    expect(githubApi.stateOf(created.name)).toBe('provisioning')

    const fetched = await ctx.codespaces.get(created.name)
    expect(fetched.state).toBe('provisioning')

    const started = await ctx.codespaces.start(created.name)
    expect(started.state).toBe('available')
    expect(githubApi.stateOf(created.name)).toBe('available')

    const listed = await ctx.codespaces.list()
    expect(listed.map(codespace => codespace.name)).toContain(created.name)

    const stopped = await ctx.codespaces.stop(created.name)
    expect(stopped.state).toBe('shutdown')

    await ctx.codespaces.remove(created.name)
    await expect(ctx.codespaces.get(created.name)).rejects.toMatchObject({ status: 404 })
  })

  it('serves repositories, branches, and machines for the pickers', async () => {
    githubApi = await FakeGitHubApi.start()
    const ctx = new Context()
    await ctx.plugin(GithubStub, 'gho_test')
    await ctx.plugin(applyCodespaces, { apiBase: githubApi.baseUrl })

    expect(await ctx.codespaces.listRepositories()).toHaveLength(1)
    expect(await ctx.codespaces.listBranches('octocat/hello-world')).toEqual([{ name: 'main', sha: 'abc123' }])
    expect(await ctx.codespaces.listMachines('octocat/hello-world')).toEqual([{ name: 'basicLinux32gb', displayName: 'Basic' }])
  })

  it('serves the devcontainer contents endpoints', async () => {
    githubApi = await FakeGitHubApi.start()
    const ctx = new Context()
    await ctx.plugin(GithubStub, 'gho_test')
    await ctx.plugin(applyCodespaces, { apiBase: githubApi.baseUrl })

    await ctx.codespaces.writeDevcontainer('octocat/hello-world')
    expect(await ctx.codespaces.readDevcontainer('octocat/hello-world')).toBe('{"name":"SoryCode"}')
  })

  it('maps a 404 to the structured not-found error', async () => {
    githubApi = await FakeGitHubApi.start()
    const ctx = new Context()
    await ctx.plugin(GithubStub, 'gho_test')
    await ctx.plugin(applyCodespaces, { apiBase: githubApi.baseUrl })

    await expect(ctx.codespaces.get('missing')).rejects.toMatchObject({ code: 'CODESPACE_NOT_FOUND', status: 404 })
  })
})

describe('FakeHarnessRuntime integration', () => {
  it('serves health, session, filesystem, terminal, and events', async () => {
    harness = await FakeHarnessRuntime.start()

    const health = await fetch(`${harness.baseUrl}/health`)
    expect(await health.json()).toMatchObject({ status: 'ok' })

    const session = await fetch(`${harness.baseUrl}/session`, { method: 'POST' })
    expect(session.status).toBe(201)
    expect(await session.json()).toMatchObject({ id: 'fake-session' })

    const read = await fetch(`${harness.baseUrl}/fs/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspaces/hello-world/file.txt' }),
    })
    expect(await read.json()).toMatchObject({ content: 'fake-content-of-/workspaces/hello-world/file.txt' })

    const terminal = await fetch(`${harness.baseUrl}/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'pwd' }),
    })
    expect(await terminal.json()).toMatchObject({ output: 'fake-output-of-pwd', exitCode: 0 })

    const events = await fetch(`${harness.baseUrl}/events`)
    expect(events.headers.get('content-type')).toContain('text/event-stream')
  })
})

class ConnectionStub extends Service {
  status: string = 'none'

  constructor(ctx: Context) {
    super(ctx, 'codespacesConnection')
  }
}

class MemoryStorageDomain extends Service {
  private readonly tables = new Map<string, Map<string, unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'storageDomain')
  }

  async open(spec: { name: string }): Promise<{
    table: (name: string) => {
      get: (key: string) => unknown
      put: (key: string, value: unknown) => Promise<void>
      delete: (key: string) => Promise<boolean>
    }
  }> {
    let table = this.tables.get(spec.name)
    if (table === undefined) {
      table = new Map()
      this.tables.set(spec.name, table)
    }
    const kv = {
      get: (key: string) => table.get(key),
      put: async (key: string, value: unknown) => { table.set(key, value) },
      delete: async (key: string) => table.delete(key),
    }
    return { table: () => kv }
  }
}

describe('controller against the fake API', () => {
  it('configures and reads the status through the Remote namespace owner', async () => {
    githubApi = await FakeGitHubApi.start()
    const ctx = new Context()
    await ctx.plugin(GithubStub, 'gho_test')
    await ctx.plugin(MemoryStorageDomain)
    await ctx.plugin(CodespaceService, { apiBase: githubApi.baseUrl })
    await ctx.plugin(CodespacesRegistry)
    await ctx.plugin(ConnectionStub)
    await ctx.plugin(CodespacesController)
    const controller = ctx.get('codespacesController') as typeof ctx.codespacesController
    expect(controller).toBeDefined()

    const configured = await controller.configure({
      workspaceId: 'workspace-1' as never,
      config: { repository: 'octocat/hello-world', branch: 'main' },
    })
    expect(configured.repository).toBe('octocat/hello-world')

    const status = await controller.getStatus({ workspaceId: 'workspace-1' as never })
    expect(status.configured).toBe(true)
    expect(status.repository).toBe('octocat/hello-world')
  })
})
