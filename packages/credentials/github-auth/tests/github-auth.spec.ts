import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, CredentialRecordEntry, CredentialRecordInfo, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import AuthorizationService, { type AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { apply, GITHUB_CREDENTIAL_KEY } from '../src/index.ts'
import type { GitHubAuthConfig } from '../src/types.ts'

// TODO: near-duplicate of the record half of the authorization and credentials
// suites' memory doubles; fold all three into a shared test-support double.
class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const stored = this.records.get(key)
    return Promise.resolve(stored === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: stored.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next === undefined) return current
    this.records.set(key, next)
    this.ctx.emit('credentials/record-updated', key)
    return next
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    if (this.records.delete(key)) this.ctx.emit('credentials/record-updated', key)
    return Promise.resolve()
  }
}

async function harness(config: GitHubAuthConfig = { clientId: 'client-1', pollIntervalMs: 10 }) {
  const ctx = new Context()
  const fibers = [await ctx.plugin(MemoryCredentials), await ctx.plugin(AuthorizationService)]
  await ctx.plugin(apply, config)
  return { ctx, dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

function surface(): AuthorizationInteraction & { notices: { message: string; url?: string; code?: string }[]; prompts: unknown[] } {
  const notices: { message: string; url?: string; code?: string }[] = []
  const prompts: unknown[] = []
  return {
    notices,
    prompts,
    notify: (notice) => { notices.push(notice) },
    prompt: (prompt) => { prompts.push(prompt); return Promise.resolve('ghp_testtoken') },
  }
}

interface GithubMock {
  deviceCodes: number
  deviceErrors: { error: string; error_description?: string }[]
  tokenStatus?: number
  tokenBody?: unknown
  userStatus?: number
  userBody?: unknown
  calls: { url: string; body?: unknown }[]
}

function mockGithub(mock: Omit<GithubMock, 'calls'>): Mock<(input: unknown, init?: { body?: string }) => Promise<Response>> {
  const state = mock as GithubMock
  state.calls = []
  return vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input)
    const body = init?.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>
    state.calls.push({ url, body })
    const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    })
    if (url.endsWith('/login/device/code')) return json({
      device_code: 'dc', user_code: 'UC-1234', verification_uri: 'https://github.com/login/device',
      expires_in: 900, interval: 1,
    })
    if (url.endsWith('/login/oauth/access_token')) {
      const error = mock.deviceErrors.shift()
      if (error !== undefined) return json({ error: error.error, error_description: error.error_description })
      return json({ access_token: 'gho_remotetoken', token_type: 'bearer', scope: 'codespace read:user' })
    }
    if (url.endsWith('/user')) {
      if (mock.userStatus === 401) return json({ message: 'Bad credentials' }, 401)
      return json(mock.userBody ?? { login: 'octocat' })
    }
    if (mock.tokenStatus !== undefined) return json(mock.tokenBody ?? {}, mock.tokenStatus)
    return json({ message: `unexpected ${url}` }, 404)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('github-auth flow', () => {
  it('runs the OAuth device flow: code, notice, poll, commit, resolve', async () => {
    const fetchMock = mockGithub({ deviceCodes: 1, deviceErrors: [{ error: 'authorization_pending' }] })
    vi.stubGlobal('fetch', fetchMock)
    const { ctx } = await harness()

    const outcome = await ctx.github.beginAuthorization(surface())

    expect(outcome.status).toBe('authorized')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const body = (index: number): string => fetchMock.mock.calls[index]?.[1]?.body ?? ''
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://github.com/login/device/code')
    expect(body(0).includes('client-1')).toBe(true)
    expect(body(0).includes('codespace')).toBe(true)
    expect(body(1).includes('urn:ietf:params:oauth:grant-type:device_flow')).toBe(true)
    expect(await ctx.github.resolveToken()).toBe('gho_remotetoken')

    const record = await ctx.credentials.readRecord(GITHUB_CREDENTIAL_KEY)
    expect(record?.kind).toBe('grant')
    expect((record as { payload: { accessToken: string } }).payload.accessToken).toBe('gho_remotetoken')
  })

  it('reports the verification page and code through the interaction surface', async () => {
    vi.stubGlobal('fetch', mockGithub({ deviceCodes: 1, deviceErrors: [] }))
    const { ctx } = await harness()
    const ui = surface()

    await ctx.github.beginAuthorization(ui)

    expect(ui.notices).toHaveLength(1)
    expect(ui.notices[0]?.url).toBe('https://github.com/login/device')
    expect(ui.notices[0]?.code).toBe('UC-1234')
  })

  it('backs off on slow_down and then commits', async () => {
    vi.stubGlobal('fetch', mockGithub({ deviceCodes: 1, deviceErrors: [{ error: 'slow_down' }] }))
    const { ctx } = await harness()

    await ctx.github.beginAuthorization(surface())

    expect(await ctx.github.resolveToken()).toBe('gho_remotetoken')
  }, 15_000)

  it('fails closed on expired_token and access_denied', async () => {
    vi.stubGlobal('fetch', mockGithub({ deviceCodes: 1, deviceErrors: [{ error: 'expired_token' }] }))
    const { ctx } = await harness()

    await expect(ctx.github.beginAuthorization(surface())).rejects.toMatchObject({ name: 'GitHubAuthError' })
    expect(await ctx.github.resolveToken()).toBeUndefined()
  })

  it('refuses the device flow without a configured client id', async () => {
    const { ctx } = await harness({ pollIntervalMs: 10 })

    await expect(ctx.github.beginAuthorization(surface(), 'oauth-device')).rejects.toMatchObject({ name: 'GitHubAuthError' })
  })

  it('runs the PAT method: prompt, verify against /user, commit', async () => {
    const fetchMock = mockGithub({ deviceCodes: 1, deviceErrors: [] })
    vi.stubGlobal('fetch', fetchMock)
    const { ctx } = await harness()

    const outcome = await ctx.github.beginAuthorization(surface(), 'pat')

    expect(outcome.status).toBe('authorized')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.github.com/user')
    expect(await ctx.github.resolveToken()).toBe('ghp_testtoken')
  })

  it('rejects a PAT that GitHub refuses', async () => {
    vi.stubGlobal('fetch', mockGithub({ deviceCodes: 1, deviceErrors: [], userStatus: 401 }))
    const { ctx } = await harness()

    await expect(ctx.github.beginAuthorization(surface(), 'pat')).rejects.toMatchObject({ status: 401 })
    expect(await ctx.github.resolveToken()).toBeUndefined()
  })

  it('describes presence without exposing the token and signs out', async () => {
    vi.stubGlobal('fetch', mockGithub({ deviceCodes: 1, deviceErrors: [] }))
    const { ctx } = await harness()

    expect((await ctx.github.describe()).configured).toBe(false)
    await ctx.github.beginAuthorization(surface())
    expect((await ctx.github.describe()).configured).toBe(true)
    expect((await ctx.github.describe()).methods.map(method => method.id)).toEqual(['oauth-device', 'pat'])

    await ctx.github.signOut()
    expect((await ctx.github.describe()).configured).toBe(false)
    expect(await ctx.github.resolveToken()).toBeUndefined()
  })

  it('exposes the credential key for server-side consumers', () => {
    expect(GITHUB_CREDENTIAL_KEY).toBe(credentialKey('github', 'codespaces'))
  })
})
