import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, codespacesWorkspaceState, type CodespacesWorkspaceState } from '../src/index.ts'

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

const WORKSPACE = 'workspace-1' as never

const STATE: CodespacesWorkspaceState = {
  kind: 'codespaces',
  repository: 'octocat/hello-world',
  branch: 'main',
  machine: 'basicLinux32gb',
  codespaceName: 'monalisa-hot-potato-vrpqrxxrx7x2rxx',
  workspaceUrl: 'https://monalisa-hot-potato-vrpqrxxrx7x2rxx-3080.app.github.dev/',
}

async function harness() {
  const ctx = new Context()
  const fibers = [await ctx.plugin(MemoryStorageDomain), await ctx.plugin(apply)]
  return { ctx, dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

describe('CodespacesRegistry', () => {
  it('returns undefined for a workspace with no stored state', async () => {
    const { ctx } = await harness()

    expect(await ctx.codespacesRegistry.read(WORKSPACE)).toBeUndefined()
  })

  it('saves and reads the complete state', async () => {
    const { ctx } = await harness()

    await ctx.codespacesRegistry.save(WORKSPACE, STATE)

    expect(await ctx.codespacesRegistry.read(WORKSPACE)).toEqual(STATE)
  })

  it('replaces the whole record on save', async () => {
    const { ctx } = await harness()

    await ctx.codespacesRegistry.save(WORKSPACE, STATE)
    await ctx.codespacesRegistry.save(WORKSPACE, { kind: 'codespaces', repository: 'octocat/other' })

    expect(await ctx.codespacesRegistry.read(WORKSPACE)).toEqual({ kind: 'codespaces', repository: 'octocat/other' })
  })

  it('removes the state', async () => {
    const { ctx } = await harness()

    await ctx.codespacesRegistry.save(WORKSPACE, STATE)
    await ctx.codespacesRegistry.remove(WORKSPACE)

    expect(await ctx.codespacesRegistry.read(WORKSPACE)).toBeUndefined()
  })

  it('validates the stored record at the durable boundary', () => {
    expect(codespacesWorkspaceState.safeParse({ kind: 'local' }).success).toBe(false)
    expect(codespacesWorkspaceState.safeParse(STATE).success).toBe(true)
  })
})
