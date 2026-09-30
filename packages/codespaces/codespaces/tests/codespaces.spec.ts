import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, CodespaceError } from '../src/index.ts'
import type { Codespace } from '../src/types.ts'

class GithubStub extends Service {
  constructor(ctx: Context, private readonly token: string | undefined) {
    super(ctx, 'github')
  }

  async resolveToken(): Promise<string | undefined> {
    return this.token
  }
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

const CODESPACE_RESPONSE = {
  id: 1,
  name: 'monalisa-hot-potato-vrpqrxxrx7x2rxx',
  display_name: 'sorycode',
  state: 'available',
  repository: {
    id: 42, name: 'hello-world', full_name: 'octocat/hello-world',
    owner: { login: 'octocat' }, private: false, default_branch: 'main',
  },
  machine: 'basicLinux32gb',
  created_at: '2026-09-29T10:00:00Z',
  updated_at: '2026-09-29T10:05:00Z',
  url: 'https://github.com/codespaces/monalisa-hot-potato-vrpqrxxrx7x2rxx',
  api_url: 'https://api.github.com/user/codespaces/monalisa-hot-potato-vrpqrxxrx7x2rxx',
}

const REPOSITORY = {
  id: 42,
  name: 'hello-world',
  full_name: 'octocat/hello-world',
  owner: { login: 'octocat' },
  private: false,
  default_branch: 'main',
}

const BRANCH = { name: 'main', commit: { sha: 'abc123' } }

interface ApiMock {
  bodies: { method: string; url: string; body?: unknown }[]
  respond: (url: string, init?: { method?: string; body?: string }) => Promise<Response>
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockApi(handler: (url: string, init?: { method?: string; body?: string }) => Response | Promise<Response>): ApiMock {
  const bodies: { method: string; url: string; body?: unknown }[] = []
  return {
    bodies,
    respond: async (input, init) => {
      const parsed = new URL(input)
      const url = `${parsed.pathname}${parsed.search}`
      bodies.push({ method: init?.method ?? 'GET', url, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }) })
      return await handler(url, init)
    },
  }
}

async function harness(token: string | undefined = 'gho_testtoken') {
  const ctx = new Context()
  const fibers = [await ctx.plugin(GithubStub, token), await ctx.plugin(apply)]
  return { ctx, dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CodespaceService', () => {
  it('creates a codespace after validating the repository and ref', async () => {
    const api = mockApi((url) => {
      if (url === '/repos/octocat/hello-world') return json(REPOSITORY)
      if (url === '/repos/octocat/hello-world/branches/main') return json(BRANCH)
      if (url === '/user/codespaces') return json(CODESPACE_RESPONSE)
      return json({ message: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', api.respond)
    const { ctx } = await harness()

    const created = await ctx.codespaces.create({ repository: 'octocat/hello-world', branch: 'main', machine: 'basicLinux32gb' })

    expect(created.name).toBe(CODESPACE.name)
    expect(api.bodies[0]?.url).toBe('/repos/octocat/hello-world')
    expect(api.bodies[1]?.url).toBe('/repos/octocat/hello-world/branches/main')
    expect(api.bodies[2]).toMatchObject({ method: 'POST', url: '/user/codespaces', body: { repository_id: 42, ref: 'main', machine: 'basicLinux32gb' } })
  })

  it('defaults the ref to the repository default branch', async () => {
    const api = mockApi((url) => {
      if (url === '/repos/octocat/hello-world') return json(REPOSITORY)
      if (url === '/repos/octocat/hello-world/branches/main') return json(BRANCH)
      if (url === '/user/codespaces') return json(CODESPACE_RESPONSE)
      return json({ message: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', api.respond)
    const { ctx } = await harness()

    await ctx.codespaces.create({ repository: 'octocat/hello-world' })

    expect(api.bodies[1]?.url).toBe('/repos/octocat/hello-world/branches/main')
    expect(api.bodies[2]?.body).toMatchObject({ repository_id: 42, ref: 'main' })
  })

  it('rejects an inaccessible repository before creating', async () => {
    const api = mockApi((url) => {
      if (url === '/repos/octocat/missing') return json({ message: 'Not Found' }, 404)
      return json({ message: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', api.respond)
    const { ctx } = await harness()

    await expect(ctx.codespaces.create({ repository: 'octocat/missing' }))
      .rejects.toMatchObject({ name: 'CodespaceError', code: 'CODESPACE_INVALID_REPOSITORY', status: 404 })
    expect(api.bodies.some(body => body.url === '/user/codespaces')).toBe(false)
  })

  it('rejects a missing ref before creating', async () => {
    const api = mockApi((url) => {
      if (url === '/repos/octocat/hello-world') return json(REPOSITORY)
      if (url === '/repos/octocat/hello-world/branches/nope') return json({ message: 'Not Found' }, 404)
      return json({ message: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', api.respond)
    const { ctx } = await harness()

    await expect(ctx.codespaces.create({ repository: 'octocat/hello-world', branch: 'nope' }))
      .rejects.toMatchObject({ code: 'CODESPACE_INVALID_REF', status: 404 })
    expect(api.bodies.some(body => body.url === '/user/codespaces')).toBe(false)
  })

  it('rejects a malformed repository spelling', async () => {
    const { ctx } = await harness()

    await expect(ctx.codespaces.create({ repository: 'not-a-repo' }))
      .rejects.toMatchObject({ code: 'CODESPACE_INVALID_REPOSITORY' })
  })

  it('gets, lists, starts, stops, and removes a codespace', async () => {
    const api = mockApi((url, init) => {
      if (url === '/user/codespaces') return json({ codespaces: [CODESPACE_RESPONSE] })
      if (url.endsWith('/start')) return json({ ...CODESPACE_RESPONSE, state: 'available' })
      if (url.endsWith('/stop')) return json({ ...CODESPACE_RESPONSE, state: 'shutdown' })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.includes('/user/codespaces/')) return json(CODESPACE_RESPONSE)
      return json({ message: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', api.respond)
    const { ctx } = await harness()

    expect((await ctx.codespaces.get(CODESPACE.name)).state).toBe('available')
    expect((await ctx.codespaces.list())).toHaveLength(1)
    expect((await ctx.codespaces.start(CODESPACE.name)).state).toBe('available')
    expect((await ctx.codespaces.stop(CODESPACE.name)).state).toBe('shutdown')
    await ctx.codespaces.remove(CODESPACE.name)
    expect(api.bodies.some(body => body.method === 'DELETE' && body.url === `/user/codespaces/${CODESPACE.name}`)).toBe(true)
  })

  it('maps a 401 to a structured authentication error', async () => {
    vi.stubGlobal('fetch', mockApi(() => json({ message: 'Bad credentials' }, 401)).respond)
    const { ctx } = await harness()

    await expect(ctx.codespaces.get(CODESPACE.name)).rejects.toMatchObject({ code: 'CODESPACE_AUTH', status: 401 })
  })

  it('maps a 403 quota message to the quota code', async () => {
    vi.stubGlobal('fetch', mockApi(() => json({ message: 'You have exceeded your quota for codespaces' }, 403)).respond)
    const { ctx } = await harness()

    await expect(ctx.codespaces.list()).rejects.toMatchObject({ code: 'CODESPACE_QUOTA', status: 403 })
  })

  it('maps a 403 permission message to the forbidden code', async () => {
    vi.stubGlobal('fetch', mockApi(() => json({ message: 'Resource not accessible by integration' }, 403)).respond)
    const { ctx } = await harness()

    await expect(ctx.codespaces.list()).rejects.toMatchObject({ code: 'CODESPACE_FORBIDDEN', status: 403 })
  })

  it('maps a 404 to not-found', async () => {
    vi.stubGlobal('fetch', mockApi(() => json({ message: 'Not Found' }, 404)).respond)
    const { ctx } = await harness()

    await expect(ctx.codespaces.get('missing')).rejects.toMatchObject({ code: 'CODESPACE_NOT_FOUND', status: 404 })
  })

  it('fails closed without a stored GitHub credential', async () => {
    const { ctx } = await harness(undefined)

    await expect(ctx.codespaces.list()).rejects.toMatchObject({ code: 'CODESPACE_AUTH' })
  })

  it('lists repositories, branches, and machines for the configuration flow', async () => {
    const api = mockApi((url) => {
      if (url === '/user/repos?per_page=100&sort=updated') return json([REPOSITORY])
      if (url === '/repos/octocat/hello-world/branches?per_page=100') return json([BRANCH])
      if (url === '/repos/octocat/hello-world/codespaces/machines') return json({ machines: [{ name: 'basicLinux32gb', display_name: 'Basic' }] })
      return json({ message: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', api.respond)
    const { ctx } = await harness()

    expect(await ctx.codespaces.listRepositories()).toEqual([
      { fullName: 'octocat/hello-world', name: 'hello-world', owner: 'octocat', isPrivate: false, defaultBranch: 'main' },
    ])
    expect(await ctx.codespaces.listBranches('octocat/hello-world')).toEqual([{ name: 'main', sha: 'abc123' }])
    expect(await ctx.codespaces.listMachines('octocat/hello-world')).toEqual([{ name: 'basicLinux32gb', displayName: 'Basic' }])
  })

  it('sends the required GitHub API headers', async () => {
    const headers: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      Object.assign(headers, init?.headers)
      return json({ codespaces: [] })
    })
    const { ctx } = await harness()

    await ctx.codespaces.list()

    expect(headers.authorization).toBe('Bearer gho_testtoken')
    expect(headers.accept).toBe('application/vnd.github+json')
    expect(headers['x-github-api-version']).toBe('2026-03-10')
    expect(headers['user-agent']).toContain('deepseek-harness')
  })

  it('exposes the error class for consumers', () => {
    expect(new CodespaceError('x', 'CODESPACE_API')).toBeInstanceOf(CodespaceError)
  })

  it('writes the devcontainer into the repository and reads it back', async () => {
    const api = mockApi((url, init) => {
      if (init?.method === 'GET' && url.endsWith('/devcontainer.json')) return json({ message: 'Not Found' }, 404)
      if (init?.method === 'PUT') return json({ content: { path: '.devcontainer/devcontainer.json' } })
      return json({ message: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', api.respond)
    const { ctx } = await harness()

    await ctx.codespaces.writeDevcontainer('octocat/hello-world')

    expect(api.bodies[0]).toMatchObject({ method: 'GET', url: '/repos/octocat/hello-world/contents/.devcontainer/devcontainer.json' })
    expect(api.bodies[1]).toMatchObject({ method: 'PUT', url: '/repos/octocat/hello-world/contents/.devcontainer/devcontainer.json' })
    const content = (api.bodies[1]?.body as { content: string }).content
    const document = JSON.parse(Buffer.from(content, 'base64').toString('utf8')) as { image: string; forwardPorts: number[]; postCreateCommand: string }
    expect(document.image).toBe('mcr.microsoft.com/devcontainers/javascript-node:22')
    expect(document.forwardPorts).toEqual([3080])
    expect(document.postCreateCommand).toContain('@deepseek-ai/dsh@')
  })

  it('updates an existing devcontainer in place', async () => {
    const api = mockApi((url, init) => {
      if (init?.method === 'GET' && url.endsWith('/devcontainer.json')) {
        return json({ content: Buffer.from('{}', 'utf8').toString('base64'), sha: 'existing-sha', type: 'file' })
      }
      if (init?.method === 'PUT') return json({ content: { path: '.devcontainer/devcontainer.json' } })
      return json({ message: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', api.respond)
    const { ctx } = await harness()

    await ctx.codespaces.writeDevcontainer('octocat/hello-world')

    expect((api.bodies[1]?.body as { sha?: string }).sha).toBe('existing-sha')
  })

  it('reads the stored devcontainer content', async () => {
    const api = mockApi((url) => {
      if (url === '/repos/octocat/hello-world/contents/.devcontainer/devcontainer.json') {
        return json({ content: Buffer.from('{"name":"SoryCode"}', 'utf8').toString('base64'), sha: 's', type: 'file' })
      }
      return json({ message: 'Not Found' }, 404)
    })
    vi.stubGlobal('fetch', api.respond)
    const { ctx } = await harness()

    expect(await ctx.codespaces.readDevcontainer('octocat/hello-world')).toBe('{"name":"SoryCode"}')
    expect(await ctx.codespaces.readDevcontainer('octocat/missing')).toBeUndefined()
  })
})
