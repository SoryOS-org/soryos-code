/** REAL-composition tier: boot package-owned cordis.yml rows through Loader and Include. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as Subprocess from '../src/index.ts'
import { E2BSubprocessRuntime } from '../src/index.ts'
import * as Fixture from './fixtures/e2b.ts'
import { fixture, resetFixture } from './fixtures/e2b.ts'

const contexts: Context[] = []
const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-e2b', Fixture],
  ['@deepseek-ai/dsh-subprocess-e2b', Subprocess],
])

const fixtureUrl = (name: string): string => new URL(`./fixtures/${name}.cordis.yml`, import.meta.url).href

beforeEach(resetFixture)
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
})

async function mount(name: string): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  context.baseUrl = new URL('./fixtures/', import.meta.url).href
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const internal = ModuleLoader.fromInternal()
  if (internal === undefined) throw new Error('test requires supported Node internals')
  context.loader.internal = { ...internal, import: async (specifier: string): Promise<unknown> => {
    const module = modules.get(specifier)
    if (module === undefined) throw new Error(`Unexpected fixture module: ${specifier}`)
    return module
  } }
  await context.loader.create({ name: 'cordis:include', config: { path: fixtureUrl(name) } })
  await context.loader.await()
  return context
}

function spec(overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', 'printf hello'],
    cwd: '/workspace/e2b',
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 200,
    ...overrides,
  }
}

async function readAll(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (stream === undefined) throw new Error('expected a piped output stream')
  let text = ''
  for await (const chunk of stream) text += String(chunk)
  return text
}

describe('subprocess-e2b package composition', () => {
  it('activates the package row from cordis.yml and runs a command inside the sandbox', async () => {
    const context = await mount('composition')
    for (const entry of context.loader.entries()) await entry.fiber?.await()
    const runtime = context.subprocess as E2BSubprocessRuntime
    expect(runtime).toBeInstanceOf(Subprocess.default)
    expect(context.e2b).toBeInstanceOf(Fixture.default)

    fixture.stdout = 'hello\n'
    const handle = runtime.spawn(spec())
    const [stdout, stderr, outcome] = await Promise.all([readAll(handle.stdout), readAll(handle.stderr), handle.done])
    expect(outcome).toEqual({ exitCode: 0, signal: null })
    expect(stdout).toBe('hello\n')
    expect(stderr).toBe('')
  })

  it('excludes the ambient sandbox credential from the command environment', async () => {
    const context = await mount('composition')
    for (const entry of context.loader.entries()) await entry.fiber?.await()
    fixture.stdout = 'ok'
    await context.subprocess.spawn(spec({ env: { DSH_MODE: 'composition' } })).done

    expect(fixture.started).toContain('printf hello')
    expect(fixture.startedCwd).toBe('/workspace/e2b')
    // The credential the sandbox reports in its ambient environment never reaches the command.
    expect(fixture.started).not.toContain('ambient-secret')
    const serialized = fixture.writes.flatMap(write => write.data).join('')
    expect(serialized).not.toContain('ambient-secret')
    expect(serialized).toContain('DSH_MODE=composition')
  })

  it('rejects a cordis.yml whose configuration fails validation', async () => {
    const context = await mount('invalid')
    const row = [...context.loader.entries()].find(entry => entry.options.id === 'subprocess')
    await expect(row?.fiber?.await()).rejects.toThrow('invalid config')
    expect(context.subprocess).toBeUndefined()
  })
})
