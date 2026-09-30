import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as githubAuth from '@deepseek-ai/dsh-github-auth'
import * as codespaces from '@deepseek-ai/dsh-codespaces'
import * as registry from '@deepseek-ai/dsh-codespaces-registry'
import * as connection from '@deepseek-ai/dsh-codespaces-connection'
import * as controller from '@deepseek-ai/dsh-api-codespaces-controller'
import * as agentPreset from '@deepseek-ai/dsh-agent-preset'
import * as fsSsh from '@deepseek-ai/dsh-fs-ssh'
import * as subprocessSsh from '@deepseek-ai/dsh-subprocess-ssh'
import * as sandboxSsh from '@deepseek-ai/dsh-sandbox-ssh'
import * as sandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as bashLocal from '@deepseek-ai/dsh-bash-local'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

class StorageDomainStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'storageDomain')
  }

  async open(): Promise<never> {
    throw new Error('not implemented')
  }
}

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
    return next
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadBundle(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-codespaces-bundle-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-github-auth'",
    '  config: {}',
    "- name: '@deepseek-ai/dsh-codespaces'",
    '  config: {}',
    "- name: '@deepseek-ai/dsh-codespaces-registry'",
    '  config: {}',
    "- name: '@deepseek-ai/dsh-codespaces-connection'",
    '  config: {}',
    "- name: '@deepseek-ai/dsh-api-codespaces-controller'",
    '  config: {}',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(StorageDomainStub)
  await context.plugin(MemoryCredentials)
  await context.plugin(AuthorizationService)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-github-auth', githubAuth],
    ['@deepseek-ai/dsh-codespaces', codespaces],
    ['@deepseek-ai/dsh-codespaces-registry', registry],
    ['@deepseek-ai/dsh-codespaces-connection', connection],
    ['@deepseek-ai/dsh-api-codespaces-controller', controller],
    ['@deepseek-ai/dsh-agent-preset', agentPreset],
    ['@deepseek-ai/dsh-fs-ssh', fsSsh],
    ['@deepseek-ai/dsh-subprocess-ssh', subprocessSsh],
    ['@deepseek-ai/dsh-sandbox-ssh', sandboxSsh],
    ['@deepseek-ai/dsh-sandbox-policy', sandboxPolicy],
    ['@deepseek-ai/dsh-bash-local', bashLocal],
    ['@deepseek-ai/dsh-terminal-bash', terminalBash],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('codespaces bundle composition', () => {
  it('loads every environment service through the Loader', async () => {
    const ctx = await loadBundle()

    expect(ctx.github).toBeDefined()
    expect(ctx.codespaces).toBeDefined()
    expect(ctx.codespacesRegistry).toBeDefined()
    expect(ctx.codespacesConnection).toBeDefined()
    expect(ctx.codespacesController).toBeDefined()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded).toEqual([])
  })

  it('mounts the default export of every service package as a class plugin', async () => {
    expect(githubAuth.default?.name).toBe('GitHubService')
    expect(codespaces.default?.name).toBe('CodespaceService')
    expect(registry.default?.name).toBe('CodespacesRegistry')
    expect(connection.default?.name).toBe('CodespaceConnection')
    expect(controller.default?.name).toBe('CodespacesController')
  })
})
