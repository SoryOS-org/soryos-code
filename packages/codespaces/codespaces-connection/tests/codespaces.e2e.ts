/**
 * Real GitHub Codespaces end-to-end test: provision a codespace, bootstrap SSH,
 * launch the remote DeepSeek Harness, resolve the forwarded endpoint, and
 * reconnect. Self-skips without a GitHub token and a test repository — keyless
 * CI runs the unit and integration suites instead.
 * @module @deepseek-ai/dsh-codespaces-connection/tests/codespaces.e2e
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CodespaceService } from '@deepseek-ai/dsh-codespaces'
import { CodespacesRegistry } from '@deepseek-ai/dsh-codespaces-registry'
import { CodespaceConnection } from '../src/index.ts'

const GITHUB_TOKEN = process.env.SORYCODE_GITHUB_TOKEN
const TEST_REPOSITORY = process.env.SORYCODE_E2E_REPOSITORY
const enabled = GITHUB_TOKEN !== undefined && TEST_REPOSITORY !== undefined

class GithubStub extends Service {
  constructor(ctx: Context, private readonly token: string | undefined) {
    super(ctx, 'github')
  }

  async resolveToken(): Promise<string | undefined> {
    return this.token
  }
}

describe.skipIf(!enabled)('Codespaces end-to-end (real GitHub)', () => {
  it('provisions, connects, and reconnects a real codespace', { timeout: 20 * 60_000 }, async () => {
    const ctx = new Context()
    await ctx.plugin(GithubStub, GITHUB_TOKEN)
    await ctx.plugin(CodespaceService)
    await ctx.plugin(CodespacesRegistry)
    await ctx.plugin(CodespaceConnection)
    const connection = ctx.codespacesConnection
    const registry = ctx.codespacesRegistry
    const workspaceId = 'e2e-workspace' as never

    await registry.save(workspaceId, { kind: 'codespaces', repository: TEST_REPOSITORY as string })

    const target = await connection.connect(workspaceId)
    expect(target.environment).toBe('codespaces')
    expect(target.url.toString()).toContain('app.github.dev')

    const reconnected = await connection.reconnect(workspaceId)
    expect(reconnected.url.toString()).toContain('app.github.dev')

    await connection.stopCodespace(workspaceId)
    await connection.deleteEnvironment(workspaceId)
    expect(await registry.read(workspaceId)).toBeUndefined()
  })
})
