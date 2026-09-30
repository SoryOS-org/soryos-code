/** REAL-composition tier: boot the package-owned cordis.yml through Loader and Include with the SDK fixture. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as E2b from '../src/index.ts'
import { fixture, resetFixture } from './fixtures/e2b.ts'

vi.mock('e2b', async () => import('./fixtures/e2b.ts'))

const contexts: Context[] = []
const modules = new Map<string, unknown>([['@deepseek-ai/dsh-e2b', E2b]])

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

describe('E2B package composition', () => {
  it('activates the package row from cordis.yml and serves ctx.e2b', async () => {
    const context = await mount('composition')
    for (const entry of context.loader.entries()) await entry.fiber?.await()
    expect(context.e2b.status()).toEqual({ state: 'absent' })
    const sandbox = await context.e2b.create()
    expect(sandbox.sandboxId).toBe('sbx-1')
    expect(fixture.createTemplates).toEqual(['custom-template'])
    expect(fixture.createOptions[0]).toMatchObject({ apiKey: 'yml-key' })
  })

  it('rejects a cordis.yml whose configuration fails validation', async () => {
    const context = await mount('invalid')
    const row = [...context.loader.entries()].find(entry => entry.options.id === 'e2b')
    await expect(row?.fiber?.await()).rejects.toThrow('invalid config')
    expect(context.e2b).toBeUndefined()
  })
})
