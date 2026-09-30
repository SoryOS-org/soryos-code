/** Real E2B command and terminal acceptance against a disposable sandbox; self-skips without E2B_API_KEY. */
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { E2bConnection, type Config } from '@deepseek-ai/dsh-e2b'
import { E2BSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-e2b'

const config = (): Config => ({
  apiKeyEnv: 'E2B_API_KEY',
  timeoutMs: 600_000,
  workspace: '/home/user/workspace-dsh-subprocess-e2e',
})

describe.skipIf(!process.env.E2B_API_KEY)('E2B subprocess real API', () => {
  it('runs commands and a terminal inside one disposable sandbox', async () => {
    const ctx = new Context()
    await ctx.plugin(E2bConnection, config())
    await ctx.plugin(E2BSubprocessRuntime)
    try {
      await ctx.e2b.create()
      await ctx.e2b.initWorkspace()
      const workspace = ctx.e2b.workspace

      const bash = await ctx.subprocess.resolveExecutable('bash')
      expect(posix.isAbsolute(bash)).toBe(true)
      expect(posix.basename(bash)).toBe('bash')
      expect((await ctx.subprocess.terminalEnvironment()).platform).toBe('posix')

      const command = ctx.subprocess.spawn({
        argv: ['bash', '-c', 'printf \'%s|%s|%s\' "$PWD" "$KEEP" "${E2B_API_KEY:-absent}"'],
        cwd: workspace,
        env: { KEEP: 'kept' },
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
        graceMs: 2_000,
      })
      const outcome = await command.done
      expect(outcome).toEqual({ exitCode: 0, signal: null })
      expect(await command.waitForExit()).toBe(true)
      expect(command.collected.stdout?.readFrom(0).text).toBe(`${workspace}|kept|absent`)

      const long = ctx.subprocess.spawn({
        argv: ['bash', '-c', 'echo started; sleep 60'],
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
        graceMs: 2_000,
      })
      await expect.poll(() => long.collected.stdout?.readFrom(0).text ?? '', { timeout: 60_000 }).toContain('started')
      long.terminate()
      await long.done
      expect(await long.waitForExit()).toBe(true)

      const terminal = await ctx.subprocess.spawnTerminal({
        argv: ['bash', '--noprofile', '--norc'],
        cwd: workspace,
        env: { DSH_SESSION_ID: 'e2e' },
        rows: 24,
        cols: 80,
        terminalType: 'xterm-256color',
        graceMs: 2_000,
      })
      let screen = ''
      terminal.output.on('data', (chunk: Buffer) => { screen += chunk.toString('utf8') })
      await terminal.write('printf "term:%s:%s\\n" "$DSH_SESSION_ID" "$TERM"\n')
      await expect.poll(() => screen, { timeout: 60_000 }).toContain('term:e2e:xterm-256color')
      await terminal.resize(100, 30)
      expect(await terminal.inspectActivity()).toEqual({ state: 'unknown', revision: 0 })
      await terminal.terminate()
      await terminal.done
    } finally {
      if (ctx.e2b.state !== 'absent') await ctx.e2b.destroy().catch(() => undefined)
      await ctx.fiber.dispose()
    }
  })
})
