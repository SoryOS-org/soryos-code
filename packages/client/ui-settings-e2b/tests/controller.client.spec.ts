import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { E2bCardController, type E2bSettings } from '../src/client/e2b-card-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubConfigForm<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value } as T, user: { ...layer(), [field]: value } })
  })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = { ...section() }
    const user = { ...layer() }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else {
        Reflect.deleteProperty(user, field)
        value[field] = (host.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
      }
    }
    host.publish({ value: value as T, user })
    return Promise.resolve(true)
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...section(), [field]: base?.[field] } as T, user })
  })
}

/** The card plugin's context, scripted down to the namespaces a card reaches. */
function ctxWith(namespaces: object) {
  return { remote: namespaces } as never
}

function credentialsApi(configured: boolean, ref = 'E2B_API_KEY') {
  const describe = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: { [ref]: { configured, writable: true } },
  }))
  const set = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  return { ctx: ctxWith({ credentials: { describe, set } }), describe, set }
}

describe('E2bCardController', () => {
  it('reads the credential state for the reference the page names', async () => {
    const host = stubConfigForm<E2bSettings>()
    const credentials = credentialsApi(true)
    const controller = new E2bCardController(host.scope, credentials.ctx)
    const state = () => controller.inject().hooks.e2bCard.getSnapshot()
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })

    host.publish({
      status: 'ready',
      writable: true,
      value: { apiKeyEnv: 'E2B_API_KEY', template: 'base', timeoutMs: 3_600_000 },
      user: {},
    })
    await vi.waitFor(() => { expect(state().apiKeyConfigured).toBe(true) })

    expect(state()).toMatchObject({
      apiKeyEnv: { text: 'E2B_API_KEY', overridden: false },
      template: { text: 'base', overridden: false },
      timeoutMs: { text: '3600000', overridden: false },
      apiKey: { text: '', overridden: false },
    })
  })

  it('writes the staged key through the credentials domain, never the settings section', async () => {
    const host = stubConfigForm<E2bSettings>()
    const credentials = credentialsApi(false)
    const controller = new E2bCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', ' e2b-secret ')
    expect(face.hooks.e2bCard.getSnapshot().dirty).toBe(true)
    expect(credentials.set).not.toHaveBeenCalled()

    credentials.describe.mockImplementation(() => Promise.resolve({
      ok: true as const,
      value: { E2B_API_KEY: { configured: true, writable: true } },
    }))
    face.save()
    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalled() })

    expect(credentials.set).toHaveBeenCalledWith('E2B_API_KEY', 'e2b-secret')
    expect(host.set).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(face.hooks.e2bCard.getSnapshot()).toMatchObject({ dirty: false, apiKeyConfigured: true })
    })
  })

  it('keeps the stored key when the draft is left blank', () => {
    const host = stubConfigForm<E2bSettings>()
    const credentials = credentialsApi(true)
    const controller = new E2bCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', '   ')
    face.save()

    expect(face.hooks.e2bCard.getSnapshot().dirty).toBe(false)
    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('addresses the reference the page declares rather than the default', async () => {
    const host = stubConfigForm<E2bSettings>()
    const credentials = credentialsApi(false, 'SANDBOX_KEY')
    const controller = new E2bCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: { apiKeyEnv: 'SANDBOX_KEY' }, user: {} })
    const face = controller.inject()

    face.edit('apiKey', 'e2b-secret')
    face.save()
    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalled() })

    expect(credentials.set).toHaveBeenCalledWith('SANDBOX_KEY', 'e2b-secret')
  })

  it('saves the reference, template, and both deadlines in one pass', async () => {
    const host = stubConfigForm<E2bSettings>()
    acceptWrites(host)
    const credentials = credentialsApi(true)
    const controller = new E2bCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('template', 'v2')
    face.edit('timeoutMs', '60000')
    face.edit('requestTimeoutMs', '5000')
    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })

    expect(host.mutate.mock.calls.map(([ops]) => ops)).toEqual([[
      { op: 'set', path: ['template'], value: 'v2' },
      { op: 'set', path: ['timeoutMs'], value: 60_000 },
      { op: 'set', path: ['requestTimeoutMs'], value: 5_000 },
    ]])
    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('re-reads when the Host reports the watched reference changed, and ignores another', async () => {
    const host = stubConfigForm<E2bSettings>()
    const credentials = credentialsApi(false)
    const controller = new E2bCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })
    credentials.describe.mockClear()

    controller.refreshCredential('OTHER_KEY')
    expect(credentials.describe).not.toHaveBeenCalled()

    credentials.describe.mockImplementation(() => Promise.resolve({
      ok: true as const,
      value: { E2B_API_KEY: { configured: true, writable: true } },
    }))
    controller.refreshCredential('E2B_API_KEY')

    await vi.waitFor(() => {
      expect(controller.inject().hooks.e2bCard.getSnapshot().apiKeyConfigured).toBe(true)
    })
  })

  it('reports a key the Host did not store as a failed save', async () => {
    const host = stubConfigForm<E2bSettings>()
    const credentials = credentialsApi(false)
    const controller = new E2bCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', 'e2b-secret')
    face.save()

    await vi.waitFor(() => {
      expect(face.hooks.e2bCard.getSnapshot()).toMatchObject({ failed: true, dirty: true })
    })
  })

  it('keeps the card usable when the credential read is refused', async () => {
    const host = stubConfigForm<E2bSettings>()
    const refusal = () => Promise.resolve({
      ok: false as const,
      error: new RemoteError('credential/rejected', 'offline', { ref: 'E2B_API_KEY' }),
    })
    const describe = vi.fn(refusal)
    const set = vi.fn(refusal)
    const controller = new E2bCardController(host.scope, ctxWith({ credentials: { describe, set } }))
    const face = controller.inject()
    await vi.waitFor(() => { expect(describe).toHaveBeenCalled() })

    host.publish({ status: 'ready', writable: true, value: { template: 'base' }, user: {} })
    face.edit('apiKey', 'e2b-secret')
    face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalled() })

    expect(face.hooks.e2bCard.getSnapshot()).toMatchObject({
      available: true,
      apiKeyConfigured: false,
      template: { text: 'base' },
    })
  })

  it('ignores a credential read the Host refused', async () => {
    const host = stubConfigForm<E2bSettings>()
    const describe = vi.fn(() => Promise.resolve({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'no credential provider', {}),
    }))
    const controller = new E2bCardController(host.scope, ctxWith({
      credentials: { describe, set: vi.fn() },
    }))
    await vi.waitFor(() => { expect(describe).toHaveBeenCalled() })

    expect(controller.inject().hooks.e2bCard.getSnapshot().apiKeyConfigured).toBe(false)
  })
})
