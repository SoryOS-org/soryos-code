/** Real E2B lifecycle against a disposable sandbox; self-skips without E2B_API_KEY. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { E2bConnection, type Config } from '../src/index.ts'

const config = (): Config => ({
  apiKeyEnv: 'E2B_API_KEY',
  timeoutMs: 600_000,
  workspace: '/home/user/workspace-e2b-test',
})

describe.skipIf(!process.env.E2B_API_KEY)('E2B connection real API', () => {
  it('runs the create, workspace, pause, resume, and destroy lifecycle', async () => {
    const ctx = new Context()
    await ctx.plugin(E2bConnection, config())
    try {
      const sandbox = await ctx.e2b.create()
      expect(ctx.e2b.status()).toMatchObject({ state: 'ready', sandboxId: sandbox.sandboxId })
      await ctx.e2b.initWorkspace()
      expect(await sandbox.files.exists('/home/user/workspace-e2b-test')).toBe(true)
      await ctx.e2b.pause()
      expect(ctx.e2b.status().state).toBe('paused')
      await ctx.e2b.resume()
      expect(ctx.e2b.status().state).toBe('ready')
      await ctx.e2b.destroy()
      expect(ctx.e2b.status()).toEqual({ state: 'absent' })
    } finally {
      if (ctx.e2b.state !== 'absent') {
        await ctx.e2b.destroy().catch(() => undefined)
      }
      await ctx.fiber.dispose()
    }
  })
})
