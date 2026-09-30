/** Unit lifecycle: the E2B connection state machine over the SDK fixture, with no network. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { E2bConnection, type ConfigInput } from '../src/index.ts'
import { fixture, resetFixture } from './fixtures/e2b.ts'

vi.mock('e2b', async () => import('./fixtures/e2b.ts'))

const contexts: Context[] = []

const config = (overrides: Partial<ConfigInput> = {}): ConfigInput =>
  ({ apiKey: 'fixture-key', apiKeyEnv: 'E2B_API_KEY', workspace: '/workspace/e2b', ...overrides })

/** One serialized schema node per configuration field, as the settings service reads them. */
function configFields(): Record<string, { meta?: Record<string, unknown> } | undefined> {
  const json = E2bConnection.Config.toJSON() as {
    uid: number
    refs: Record<string, { dict?: Record<string, number>; meta?: Record<string, unknown> }>
  }
  const root = json.refs[String(json.uid)]
  if (root?.dict === undefined) throw new Error('expected the root schema node to carry its field map')
  return Object.fromEntries(Object.entries(root.dict).map(([field, ref]) => [field, json.refs[String(ref)]]))
}

beforeEach(resetFixture)
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  delete process.env.DSH_E2B_FIXTURE_KEY
})

async function mount(options: ConfigInput): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(E2bConnection, options)
  return ctx
}

describe('E2B connection lifecycle', () => {
  it('registers as ctx.e2b and reports absent without contacting E2B', async () => {
    const ctx = await mount(config())
    expect(ctx.e2b.status()).toEqual({ state: 'absent' })
    expect(ctx.e2b.state).toBe('absent')
    expect(ctx.e2b.workspace).toBe('/workspace/e2b')
    expect(() => ctx.e2b.sandbox).toThrow('E2B connection owns no sandbox while absent')
    expect(fixture.sandboxes).toHaveLength(0)
    expect(fixture.createOptions).toHaveLength(0)
  })

  it('refuses lifecycle operations while it owns no sandbox', async () => {
    const ctx = await mount(config())
    await expect(ctx.e2b.pause()).rejects.toThrow('E2B connection owns no sandbox while absent')
    await expect(ctx.e2b.resume()).rejects.toThrow('E2B connection owns no sandbox while absent')
    await expect(ctx.e2b.destroy()).rejects.toThrow('E2B connection owns no sandbox while absent')
    await expect(ctx.e2b.initWorkspace()).rejects.toThrow('E2B workspace requires a running sandbox while absent')
    expect(fixture.pauseOptions).toHaveLength(0)
    expect(fixture.killOptions).toHaveLength(0)
  })

  it('creates a sandbox, owns it, and refuses a second owner', async () => {
    const ctx = await mount(config())
    const sandbox = await ctx.e2b.create()
    expect(sandbox.sandboxId).toBe('sbx-1')
    expect(ctx.e2b.status()).toEqual({ state: 'ready', sandboxId: 'sbx-1' })
    expect(ctx.e2b.sandbox).toBe(sandbox)
    expect(fixture.createOptions[0]).toMatchObject({ apiKey: 'fixture-key' })
    expect(fixture.createTemplates[0]).toBeUndefined()
    await expect(ctx.e2b.create()).rejects.toThrow('E2B connection already owns sandbox sbx-1')
    await expect(ctx.e2b.connect('sbx-9')).rejects.toThrow('E2B connection already owns sandbox sbx-1')
    expect(fixture.connectIds).toHaveLength(0)
  })

  it('passes domain, template, lifetime, deadline, and cancellation to create', async () => {
    const ctx = await mount({
      apiKey: 'fixture-key',
      apiKeyEnv: 'E2B_API_KEY',
      domain: 'e2b.example.test',
      template: 'custom',
      timeoutMs: 60_000,
      requestTimeoutMs: 5_000,
      workspace: '/workspace/e2b',
    })
    const lifetime = new AbortController()
    await ctx.e2b.create(lifetime.signal)
    expect(fixture.createTemplates).toEqual(['custom'])
    expect(fixture.createOptions[0]).toMatchObject({
      apiKey: 'fixture-key',
      domain: 'e2b.example.test',
      requestTimeoutMs: 5_000,
      timeoutMs: 60_000,
      signal: lifetime.signal,
    })
  })

  it('resolves the key from apiKeyEnv and fails before any request while it is unset', async () => {
    const ctx = await mount({ apiKeyEnv: 'DSH_E2B_FIXTURE_KEY', workspace: '/workspace/e2b' })
    const message = 'E2B API key is not configured: set apiKey or the DSH_E2B_FIXTURE_KEY credential reference'
    await expect(ctx.e2b.create()).rejects.toThrow(message)
    expect(ctx.e2b.status()).toEqual({ state: 'failed', error: message })
    expect(fixture.createOptions).toHaveLength(0)
    process.env.DSH_E2B_FIXTURE_KEY = ''
    await expect(ctx.e2b.create()).rejects.toThrow(message)
    process.env.DSH_E2B_FIXTURE_KEY = 'env-key'
    const sandbox = await ctx.e2b.create()
    expect(fixture.createOptions[0]).toMatchObject({ apiKey: 'env-key' })
    expect(ctx.e2b.status()).toEqual({ state: 'ready', sandboxId: sandbox.sandboxId })
  })

  it('prefers the credential the session settings card stored over the ambient environment', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const resolved: string[] = []
    ctx.provide('credentials', {
      async resolve(ref: string) {
        resolved.push(ref)
        return ref === 'E2B_SESSION_KEY' ? { value: 'card-key', source: 'file' } : undefined
      },
    } as never)
    await ctx.plugin(E2bConnection, { apiKeyEnv: 'E2B_SESSION_KEY', workspace: '/workspace/e2b' })
    process.env.E2B_SESSION_KEY = 'env-key'

    await ctx.e2b.create()
    expect(resolved).toEqual(['E2B_SESSION_KEY'])
    expect(fixture.createOptions[0]).toMatchObject({ apiKey: 'card-key' })

    // The card is a live write, so the next call re-resolves rather than caching.
    await ctx.e2b.destroy()
    resolved.length = 0
    await ctx.e2b.create()
    expect(resolved).toEqual(['E2B_SESSION_KEY'])
    delete process.env.E2B_SESSION_KEY
  })

  it('keeps a configured apiKey literal ahead of the credential store', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const resolve = vi.fn(async () => ({ value: 'card-key', source: 'file' }))
    ctx.provide('credentials', { resolve } as never)
    await ctx.plugin(E2bConnection, config({ apiKey: 'literal-key' }))

    await ctx.e2b.create()
    expect(resolve).not.toHaveBeenCalled()
    expect(fixture.createOptions[0]).toMatchObject({ apiKey: 'literal-key' })
  })

  it('connects by ID, pauses, resumes, and destroys', async () => {
    const ctx = await mount({ ...config(), timeoutMs: 60_000 })
    await expect(ctx.e2b.connect('')).rejects.toThrow('E2B sandbox ID must not be empty')
    expect(fixture.connectIds).toHaveLength(0)
    const sandbox = await ctx.e2b.connect('sbx-42')
    expect(sandbox.sandboxId).toBe('sbx-42')
    expect(fixture.connectIds).toEqual(['sbx-42'])
    expect(fixture.connectOptions[0]).toMatchObject({ apiKey: 'fixture-key', timeoutMs: 60_000 })
    expect(ctx.e2b.status()).toEqual({ state: 'ready', sandboxId: 'sbx-42' })
    await ctx.e2b.pause()
    expect(fixture.pauseOptions).toHaveLength(1)
    expect(ctx.e2b.status()).toEqual({ state: 'paused', sandboxId: 'sbx-42' })
    await ctx.e2b.pause()
    expect(fixture.pauseOptions).toHaveLength(1)
    await ctx.e2b.resume()
    expect(fixture.resumeOptions).toHaveLength(1)
    expect(fixture.resumeOptions[0]).toMatchObject({ timeoutMs: 60_000 })
    await ctx.e2b.resume()
    expect(fixture.resumeOptions).toHaveLength(1)
    await ctx.e2b.destroy()
    expect(fixture.killOptions).toHaveLength(1)
    expect(ctx.e2b.status()).toEqual({ state: 'absent' })
  })

  it('records connect, pause, and destroy failures without losing the sandbox', async () => {
    const ctx = await mount(config())
    fixture.connectError = new Error('connect boom')
    await expect(ctx.e2b.connect('sbx-7')).rejects.toThrow('connect boom')
    expect(ctx.e2b.status()).toEqual({ state: 'failed', error: 'connect boom' })
    expect(() => ctx.e2b.sandbox).toThrow('E2B connection owns no sandbox while failed')
    fixture.connectError = undefined

    const sandbox = await ctx.e2b.create()
    fixture.pauseError = new Error('pause boom')
    await expect(ctx.e2b.pause()).rejects.toThrow('pause boom')
    expect(ctx.e2b.status()).toEqual({ state: 'ready', sandboxId: sandbox.sandboxId, error: 'pause boom' })
    fixture.pauseError = undefined
    await ctx.e2b.pause()
    expect(ctx.e2b.status()).toEqual({ state: 'paused', sandboxId: sandbox.sandboxId })

    fixture.resumeError = 'plain resume failure'
    await expect(ctx.e2b.resume()).rejects.toEqual('plain resume failure')
    expect(ctx.e2b.status()).toEqual({ state: 'paused', sandboxId: sandbox.sandboxId, error: 'plain resume failure' })
    fixture.resumeError = undefined
    await ctx.e2b.resume()

    fixture.killError = new Error('kill boom')
    await expect(ctx.e2b.destroy()).rejects.toThrow('kill boom')
    expect(ctx.e2b.status()).toEqual({ state: 'ready', sandboxId: sandbox.sandboxId, error: 'kill boom' })
    expect(fixture.killOptions).toHaveLength(1)
    fixture.killError = undefined
    await ctx.e2b.destroy()
    expect(ctx.e2b.status()).toEqual({ state: 'absent' })
  })

  it('serializes racing creates and queues a destroy behind an unsettled create', async () => {
    const ctx = await mount(config())
    const first = ctx.e2b.create()
    const second = ctx.e2b.create()
    await expect(second).rejects.toThrow('E2B connection already owns sandbox sbx-1')
    expect((await first).sandboxId).toBe('sbx-1')

    const queuedCtx = await mount(config())
    const created = queuedCtx.e2b.create()
    const killed = queuedCtx.e2b.destroy()
    await expect(created).resolves.toMatchObject({ sandboxId: 'sbx-2' })
    await killed
    expect(queuedCtx.e2b.status()).toEqual({ state: 'absent' })
    expect(fixture.killOptions).toHaveLength(1)
  })

  it('creates the configured workspace only while running', async () => {
    const ctx = await mount({ ...config(), requestTimeoutMs: 5_000 })
    await ctx.e2b.create()
    const workspace = new AbortController()
    await ctx.e2b.initWorkspace(workspace.signal)
    expect(fixture.makeDirs.map(call => call.path)).toEqual(['/workspace/e2b'])
    expect(fixture.makeDirs[0]?.opts).toMatchObject({ requestTimeoutMs: 5_000, signal: workspace.signal })
    await ctx.e2b.pause()
    await expect(ctx.e2b.initWorkspace()).rejects.toThrow('E2B workspace requires a running sandbox while paused')
    expect(fixture.makeDirs).toHaveLength(1)
    await ctx.e2b.resume()
    fixture.makeDirError = new Error('disk full')
    await expect(ctx.e2b.initWorkspace()).rejects.toThrow('disk full')
    expect(ctx.e2b.status()).toMatchObject({ state: 'ready', error: 'disk full' })
    fixture.makeDirError = undefined

    const plain = await mount(config())
    await plain.e2b.create()
    await plain.e2b.initWorkspace()
    expect(fixture.makeDirs.map(call => call.path)).toEqual(['/workspace/e2b', '/workspace/e2b', '/workspace/e2b'])
    expect(fixture.makeDirs[2]?.opts).toEqual({})
  })

  it('drops local ownership at disposal without killing the remote sandbox', async () => {
    const ctx = await mount(config())
    const e2b = ctx.e2b
    await e2b.create()
    await ctx.fiber.dispose()
    expect(e2b.status()).toEqual({ state: 'absent' })
    expect(fixture.killOptions).toHaveLength(0)
  })

  it('validates configuration through the standard schema with loader defaults', async () => {
    const invalid = await E2bConnection.Config['~standard'].validate({ workspace: '/workspace/e2b', timeoutMs: 'soon' })
    expect('issues' in invalid).toBe(true)
    const valid = await E2bConnection.Config['~standard'].validate({ workspace: '/workspace/e2b' })
    if (!('value' in valid)) throw new Error('expected the defaulted configuration to validate')
    // Volatile fields reach the plugin as stable references, not as the loader's plain values.
    expect(valid.value.workspace).toBe('/workspace/e2b')
    expect(valid.value.apiKeyEnv.get()).toBe('E2B_API_KEY')
    expect(valid.value.domain.get()).toBeUndefined()
    expect(valid.value.template.get()).toBeUndefined()
    expect(valid.value.timeoutMs.get()).toBeUndefined()
    expect(valid.value.requestTimeoutMs.get()).toBeUndefined()
  })

  it('exposes exactly the form fields the session settings card edits', () => {
    const fields = configFields()
    // The card edits these; the settings service publishes only volatile nodes.
    expect(Object.keys(fields).filter(field => fields[field]?.meta?.volatile === true).sort()).toEqual([
      'apiKeyEnv', 'domain', 'requestTimeoutMs', 'template', 'timeoutMs',
    ])
    // The credential reference the card writes through, carrying its default so
    // the form shows a value rather than a blank.
    expect(fields.apiKeyEnv?.meta).toMatchObject({ role: 'credential-ref', default: 'E2B_API_KEY' })
    // A key literal is a secret the wire never carries, and an ordinary field the
    // form excludes; the card writes the key through the credentials store instead.
    expect(fields.apiKey?.meta).toEqual({ role: 'secret' })
    expect(fields.apiKey?.meta?.volatile).toBeUndefined()
    // The preset owns the workspace, so it stays out of the form.
    expect(fields.workspace?.meta).toEqual({ required: true })
  })
})
