/** REAL-composition tier: boot package-owned cordis.yml rows through Loader and Include. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Fse2b from '../src/index.ts'
import { E2bFileSystem } from '../src/index.ts'
import * as Fixture from './fixtures/e2b.ts'
import { resetFixture, seedFile } from './fixtures/e2b.ts'

const contexts: Context[] = []
const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-e2b', Fixture],
  ['@deepseek-ai/dsh-fs-e2b', Fse2b],
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

describe('fs-e2b package composition', () => {
  it('activates the package row from cordis.yml and serves ctx.fs', async () => {
    const context = await mount('composition')
    for (const entry of context.loader.entries()) await entry.fiber?.await()
    const fs = context.fs as E2bFileSystem
    expect(fs.config).toEqual({ cwd: '/workspace/e2b', diffBasisMaxBytes: 4096 })
    expect(context.e2b).toBeInstanceOf(Fixture.default)
    seedFile('/workspace/e2b/note.txt', 'hello')
    const target = await context.fs.resolve('note.txt')
    expect(await context.fs.readText(target)).toBe('hello')
  })

  it('rejects a cordis.yml whose configuration fails validation', async () => {
    const context = await mount('invalid')
    const row = [...context.loader.entries()].find(entry => entry.options.id === 'fs')
    await expect(row?.fiber?.await()).rejects.toThrow('invalid config')
    expect(context.fs).toBeUndefined()
  })
})
