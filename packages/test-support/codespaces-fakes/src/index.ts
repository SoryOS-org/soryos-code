/**
 * Fake GitHub Codespaces API and fake Harness runtime for integration tests.
 * These fakes exist so the Codespaces integration can be exercised without a
 * GitHub account; they are test-only and never production implementations.
 * @module @deepseek-ai/dsh-codespaces-fakes
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One stored codespace record inside the fake. */
interface FakeCodespace {
  id: number
  name: string
  display_name: string
  state: string
  repository: { id: number; name: string; full_name: string; owner: { login: string }; private: boolean; default_branch: string }
  machine: string
  created_at: string
  updated_at: string
  url: string
  api_url: string
}

/** The fake GitHub Codespaces REST API: lifecycle, repositories, branches, machines, devcontainer contents. */
export class FakeGitHubApi {
  private server: Server
  private codespaces = new Map<string, FakeCodespace>()
  private nextId = 1
  private requestLog: { method: string; path: string; body?: unknown }[] = []
  private states = new Map<string, string>()

  private constructor(server: Server) {
    this.server = server
  }

  /**
   * Start the fake API on an ephemeral port.
   * @returns the running fake.
   */
  static async start(): Promise<FakeGitHubApi> {
    const fake = new FakeGitHubApi(createServer((req, res) => { void fake.handle(req, res) }))
    await new Promise<void>((resolve) => { fake.server.listen(0, '127.0.0.1', () => { resolve() }) })
    return fake
  }

  /** The base URL of the fake API. */
  get baseUrl(): string {
    const address = this.server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  /** Every request the fake received, in order. */
  get requests(): readonly { method: string; path: string; body?: unknown }[] {
    return this.requestLog
  }

  /** The states the fake observed per codespace name. */
  stateOf(name: string): string | undefined {
    return this.states.get(name)
  }

  /** Stop the fake. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    let body: Record<string, unknown> = {}
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length > 0) {
        try { body = JSON.parse(text) as Record<string, unknown> } catch { body = {} }
      }
    }
    this.requestLog.push({ method: req.method ?? 'GET', path, ...(Object.keys(body).length === 0 ? {} : { body }) })
    const json = (value: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const segments = path.split('/').filter(segment => segment !== '')

    if (req.method === 'GET' && path === '/user/repos') {
      json([{ id: 42, name: 'hello-world', full_name: 'octocat/hello-world', owner: { login: 'octocat' }, private: false, default_branch: 'main' }]); return
    }
    if (req.method === 'GET' && path === '/repos/octocat/hello-world') {
      json({ id: 42, name: 'hello-world', full_name: 'octocat/hello-world', owner: { login: 'octocat' }, private: false, default_branch: 'main' }); return
    }
    if (req.method === 'GET' && path === '/repos/octocat/hello-world/branches/main') {
      json({ name: 'main', commit: { sha: 'abc123' } }); return
    }
    if (req.method === 'GET' && path === '/repos/octocat/hello-world/branches') {
      json([{ name: 'main', commit: { sha: 'abc123' } }]); return
    }
    if (req.method === 'GET' && path === '/repos/octocat/hello-world/codespaces/machines') {
      json({ machines: [{ name: 'basicLinux32gb', display_name: 'Basic' }] }); return
    }
    if (req.method === 'GET' && path === '/user/codespaces') {
      json({ codespaces: [...this.codespaces.values()] }); return
    }
    if (req.method === 'POST' && path === '/user/codespaces') {
      const input = body as { display_name?: string; machine?: string }
      const name = `fake-codespace-${this.nextId++}`
      const record: FakeCodespace = {
        id: this.nextId,
        name,
        display_name: input.display_name ?? 'sorycode',
        state: 'provisioning',
        repository: { id: 42, name: 'hello-world', full_name: 'octocat/hello-world', owner: { login: 'octocat' }, private: false, default_branch: 'main' },
        machine: input.machine ?? 'basicLinux32gb',
        created_at: '2026-09-29T10:00:00Z',
        updated_at: '2026-09-29T10:00:00Z',
        url: `https://github.com/codespaces/${name}`,
        api_url: `${this.baseUrl}/user/codespaces/${name}`,
      }
      this.codespaces.set(name, record)
      this.states.set(name, 'provisioning')
      json(record, 201); return
    }
    const codespaceMatch = /^\/user\/codespaces\/([^/]+?)(\/(start|stop))?$/.exec(path)
    if (req.method === 'GET' && codespaceMatch !== null) {
      const record = this.codespaces.get(codespaceMatch[1] as string)
      if (record === undefined) { json({ message: 'Not Found' }, 404); return }
      json(record); return
    }
    if (req.method === 'POST' && codespaceMatch !== null && path.endsWith('/start')) {
      const record = this.codespaces.get(codespaceMatch[1] as string)
      if (record === undefined) { json({ message: 'Not Found' }, 404); return }
      record.state = 'available'
      this.states.set(record.name, 'available')
      json(record); return
    }
    if (req.method === 'POST' && codespaceMatch !== null && path.endsWith('/stop')) {
      const record = this.codespaces.get(codespaceMatch[1] as string)
      if (record === undefined) { json({ message: 'Not Found' }, 404); return }
      record.state = 'shutdown'
      this.states.set(record.name, 'shutdown')
      json(record); return
    }
    if (req.method === 'DELETE' && codespaceMatch !== null) {
      const record = this.codespaces.get(codespaceMatch[1] as string)
      if (record === undefined) { json({ message: 'Not Found' }, 404); return }
      this.codespaces.delete(record.name)
      this.states.delete(record.name)
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'GET' && path.endsWith('/contents/.devcontainer/devcontainer.json')) {
      json({ content: Buffer.from('{"name":"SoryCode"}', 'utf8').toString('base64'), sha: 'fake-sha', type: 'file' }); return
    }
    if (req.method === 'PUT' && path.endsWith('/contents/.devcontainer/devcontainer.json')) {
      json({ content: { path: '.devcontainer/devcontainer.json' } }); return
    }
    void segments
    json({ message: `unexpected ${req.method} ${path}` }, 404); return
  }
}

/** The fake Harness runtime: health, session, filesystem, terminal, and events endpoints. */
export class FakeHarnessRuntime {
  private server: Server

  private constructor(server: Server) {
    this.server = server
  }

  /**
   * Start the fake runtime on an ephemeral port.
   * @returns the running fake.
   */
  static async start(): Promise<FakeHarnessRuntime> {
    const fake = new FakeHarnessRuntime(createServer((req, res) => { void fake.handle(req, res) }))
    await new Promise<void>((resolve) => { fake.server.listen(0, '127.0.0.1', () => { resolve() }) })
    return fake
  }

  /** The base URL of the fake runtime. */
  get baseUrl(): string {
    const address = this.server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  /** Stop the fake. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (value: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (url.pathname === '/health') { json({ status: 'ok', runtime: 'fake-harness' }); return }
    if (url.pathname === '/session' && req.method === 'POST') { json({ id: 'fake-session', cwd: '/workspaces/hello-world' }, 201); return }
    if (url.pathname === '/fs/read' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { path: string }
      json({ content: `fake-content-of-${body.path}` }); return
    }
    if (url.pathname === '/terminal' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { command: string }
      json({ output: `fake-output-of-${body.command}`, exitCode: 0 }); return
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: ready\ndata: {}\n\n')
      return
    }
    json({ message: `unexpected ${req.method} ${url.pathname}` }, 404); return
  }
}
