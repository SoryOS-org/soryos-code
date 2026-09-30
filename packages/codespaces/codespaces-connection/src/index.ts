/**
 * Codespaces environment connection (`ctx.codespacesConnection`): the full
 * lifecycle from configuration to a connected remote workspace — provision the
 * codespace, bootstrap SSH, launch the remote DeepSeek Harness, discover the
 * forwarded endpoint, and reconnect after a network loss without recreating
 * the environment. The remote filesystem, terminal, and processes ride the
 * existing SSH provider family mounted on the connection this service owns.
 * @module @deepseek-ai/dsh-codespaces-connection
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { SshConnection } from '@deepseek-ai/dsh-ssh'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Codespace, CreateCodespaceInput } from '@deepseek-ai/dsh-codespaces'
import type { CodespacesWorkspaceState } from '@deepseek-ai/dsh-codespaces-registry'
import type { CodespaceConnectionErrorCode, CodespaceLifecycle, RemoteWorkspaceTarget } from './types.ts'

export type { CodespaceConnectionErrorCode, CodespaceLifecycle, RemoteWorkspaceTarget } from './types.ts'

/** One Codespaces connection failure with a stable machine-routable code. */
export class CodespaceConnectionError extends Error {
  /**
   * @param message - provider-safe diagnostic; never carries a token.
   * @param code - the structured failure code.
   */
  constructor(message: string, readonly code: CodespaceConnectionErrorCode) {
    super(message)
    this.name = 'CodespaceConnectionError'
  }
}

/** The SSH config file `gh codespace ssh --config` writes. */
const GH_SSH_CONFIG = `${process.env.HOME ?? '/root'}/.ssh/codespaces`

/** The Include line this integration adds to the user's OpenSSH config. */
const GH_SSH_INCLUDE = `Include ${GH_SSH_CONFIG}`

/** The remote helper path inside the codespace. */
const REMOTE_HELPER_PATH = '/home/node/.dsh/ssh-helper.js'

/** The remote harness port requested from the launch command. */
const HARNESS_PORT = 3080

/** Codespace availability poll interval in milliseconds. */
const AVAILABILITY_POLL_MS = 5_000

/** Codespace availability timeout in milliseconds (15 minutes). */
const AVAILABILITY_TIMEOUT_MS = 15 * 60_000

/** The launch URL pattern the harness CLI prints once it listens. */
const LAUNCH_URL_PATTERN = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=[A-Za-z0-9_-]+/

declare module '@deepseek-ai/cordis' {
  interface Context {
    codespacesConnection: CodespaceConnection
  }
}

/** `ctx.codespacesConnection`: the Codespaces environment lifecycle owner. */
export class CodespaceConnection extends Service {
  static inject = ['github', 'codespaces', 'codespacesRegistry']

  private lifecycle: CodespaceLifecycle = 'none'
  private target: RemoteWorkspaceTarget | undefined
  private ssh: SshConnection | undefined
  private sshHost: string | undefined
  private harnessProcess: ReturnType<typeof spawn> | undefined

  constructor(ctx: Context, _config: Record<string, string> = {}) {
    super(ctx, 'codespacesConnection')
  }

  /** The current lifecycle state (a projection; GitHub remains authoritative). */
  get status(): CodespaceLifecycle {
    return this.lifecycle
  }

  /** The connected remote workspace target, or undefined while not connected. */
  get workspaceTarget(): RemoteWorkspaceTarget | undefined {
    return this.target
  }

  /**
   * Connect one workspace to its Codespace environment, reusing the provisioned
   * codespace when the stored state names one. The full flow: ensure the
   * codespace exists, wait for availability, bootstrap SSH, launch the remote
   * harness, resolve the forwarded endpoint, and persist the target.
   * @param workspaceId - the workspace to connect.
   * @param signal - cancels every step.
   * @returns the remote workspace target.
   */
  async connect(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<RemoteWorkspaceTarget> {
    let state = await this.ctx.codespacesRegistry.read(workspaceId)
    if (state === undefined) {
      throw new CodespaceConnectionError(
        'this workspace has no Codespaces environment configured; configure the repository and branch first',
        'NO_ENVIRONMENT_CONFIGURED')
    }
    if (state.codespaceName === undefined) {
      state = await this.provisionCodespace(workspaceId, state, signal)
    } else {
      this.setLifecycle('starting')
      state = await this.verifyOrReprovision(workspaceId, state, signal)
    }
    const name = state.codespaceName as string
    await this.waitForAvailability(name, signal)
    this.setLifecycle('started')
    const host = await this.bootstrapSsh(signal)
    this.setLifecycle('bootstrapping')
    const endpoint = await this.startHarness(host, state, signal)
    this.setLifecycle('harness-starting')
    const url = await this.resolveForwardedUrl(name, endpoint.port, signal)
    this.setLifecycle('ready')
    state = { ...state, workspaceUrl: url.toString() }
    await this.ctx.codespacesRegistry.save(workspaceId, state)
    this.target = { url, workspaceId, environment: 'codespaces' }
    this.setLifecycle('connected')
    return this.target
  }

  /**
   * Reconnect after a network loss: the codespace is re-read from GitHub, the
   * harness process is treated as lost, and the endpoint is re-resolved. A new
   * codespace is created only when GitHub reports the old one deleted.
   * @param workspaceId - the workspace to reconnect.
   * @param signal - cancels every step.
   * @returns the remote workspace target.
   */
  async reconnect(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<RemoteWorkspaceTarget> {
    this.setLifecycle('reconnecting')
    const state = await this.ctx.codespacesRegistry.read(workspaceId)
    if (state === undefined || state.codespaceName === undefined) {
      return await this.connect(workspaceId, signal)
    }
    const name = state.codespaceName
    try {
      await this.ctx.codespaces.get(name, signal)
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 404) {
        await this.ctx.codespacesRegistry.save(workspaceId, { ...state, codespaceName: undefined, workspaceUrl: undefined })
        return await this.connect(workspaceId, signal)
      }
      throw error
    }
    await this.disconnect().catch(() => {})
    const host = await this.bootstrapSsh(signal)
    this.setLifecycle('bootstrapping')
    const endpoint = await this.startHarness(host, state, signal)
    this.setLifecycle('harness-starting')
    const url = await this.resolveForwardedUrl(name, endpoint.port, signal)
    this.setLifecycle('ready')
    await this.ctx.codespacesRegistry.save(workspaceId, { ...state, workspaceUrl: url.toString() })
    this.target = { url, workspaceId, environment: 'codespaces' }
    this.setLifecycle('connected')
    return this.target
  }

  /**
   * Stop the remote harness process and close the SSH connection. The
   * codespace itself keeps running; the stored state is untouched.
   */
  async disconnect(): Promise<void> {
    this.harnessProcess?.kill('SIGTERM')
    this.harnessProcess = undefined
    const ssh = this.ssh
    this.ssh = undefined
    this.sshHost = undefined
    if (ssh !== undefined) await ssh.dispose()
    if (this.lifecycle !== 'none') this.setLifecycle('stopped')
  }

  /**
   * Delete the codespace and clear the stored environment state. Destructive
   * and irreversible: the filesystem and every process inside the codespace
   * are lost. The configuration fields are cleared with it; recreating the
   * environment starts from the repository selection.
   * @param workspaceId - the workspace whose environment should be deleted.
   * @param signal - cancels the deletion.
   */
  async deleteEnvironment(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> {
    this.setLifecycle('stopping')
    const state = await this.ctx.codespacesRegistry.read(workspaceId)
    if (state?.codespaceName !== undefined) {
      await this.ctx.codespaces.remove(state.codespaceName, signal)
    }
    await this.disconnect()
    await this.ctx.codespacesRegistry.remove(workspaceId)
    this.target = undefined
    this.setLifecycle('none')
  }

  /**
   * Stop the codespace (the filesystem survives; the processes do not) and
   * clear the runtime fields of the stored state.
   * @param workspaceId - the workspace whose codespace should stop.
   * @param signal - cancels the stop.
   */
  async stopCodespace(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> {
    this.setLifecycle('stopping')
    const state = await this.ctx.codespacesRegistry.read(workspaceId)
    if (state?.codespaceName !== undefined) {
      await this.ctx.codespaces.stop(state.codespaceName, signal)
      await this.ctx.codespacesRegistry.save(workspaceId, { ...state, workspaceUrl: undefined })
    }
    await this.disconnect()
    this.setLifecycle('stopped')
  }

  private setLifecycle(lifecycle: CodespaceLifecycle): void {
    this.lifecycle = lifecycle
    this.ctx.logger.info('codespaces: lifecycle %s', lifecycle)
  }

  private async provisionCodespace(
    workspaceId: WorkspaceId,
    state: CodespacesWorkspaceState,
    signal?: AbortSignal,
  ): Promise<CodespacesWorkspaceState> {
    this.setLifecycle('creating')
    await this.ctx.codespaces.writeDevcontainer(state.repository, signal)
    const input: CreateCodespaceInput = {
      repository: state.repository,
      ...(state.branch === undefined ? {} : { branch: state.branch }),
      ...(state.machine === undefined ? {} : { machine: state.machine }),
      ...(state.devcontainerPath === undefined ? {} : { devcontainerPath: state.devcontainerPath }),
      ...(state.idleTimeoutMinutes === undefined ? {} : { idleTimeoutMinutes: state.idleTimeoutMinutes }),
      ...(state.retentionPeriodMinutes === undefined ? {} : { retentionPeriodMinutes: state.retentionPeriodMinutes }),
      ...(state.location === undefined ? {} : { location: state.location }),
      ...(state.displayName === undefined ? {} : { displayName: state.displayName }),
    }
    const codespace = await this.ctx.codespaces.create(input, signal)
    const next = { ...state, codespaceName: codespace.name }
    await this.ctx.codespacesRegistry.save(workspaceId, next)
    return next
  }

  private async verifyOrReprovision(
    workspaceId: WorkspaceId,
    state: CodespacesWorkspaceState,
    signal?: AbortSignal,
  ): Promise<CodespacesWorkspaceState> {
    try {
      await this.ctx.codespaces.get(state.codespaceName as string, signal)
      return state
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 404) {
        return await this.provisionCodespace(workspaceId, { ...state, codespaceName: undefined }, signal)
      }
      throw error
    }
  }

  private async waitForAvailability(name: string, signal?: AbortSignal): Promise<Codespace> {
    const deadline = Date.now() + AVAILABILITY_TIMEOUT_MS
    for (;;) {
      signal?.throwIfAborted()
      const codespace = await this.ctx.codespaces.get(name, signal)
      if (codespace.state === 'available') return codespace
      if (codespace.state === 'failed' || codespace.state === 'deleted') {
        throw new CodespaceConnectionError(
          `codespace "${name}" is in state "${codespace.state}" and cannot be started`,
          'CODESPACE_UNAVAILABLE')
      }
      if (Date.now() >= deadline) {
        throw new CodespaceConnectionError(
          `codespace "${name}" did not become available within ${AVAILABILITY_TIMEOUT_MS / 60_000} minutes`,
          'CODESPACE_PROVISION_TIMEOUT')
      }
      await new Promise<void>(resolve => setTimeout(resolve, AVAILABILITY_POLL_MS))
    }
  }

  private async bootstrapSsh(signal?: AbortSignal): Promise<string> {
    const config = await this.ensureSshConfig(signal)
    const host = this.parseFirstHost(config)
    if (host === undefined) {
      throw new CodespaceConnectionError(
        'the GitHub CLI produced no SSH host alias for the codespace',
        'SSH_CONFIG_FAILED')
    }
    await this.deployHelper(host, signal)
    const [node, workspace] = await Promise.all([
      this.resolveRemotePath(host, 'which node', signal),
      this.resolveRemotePath(host, 'pwd', signal),
    ])
    const helperHash = await this.localHelperHash()
    this.sshHost = host
    this.ssh = await this.openSshConnection({ host, node, helper: REMOTE_HELPER_PATH, helperHash, workspace })
    return host
  }

  private async ensureSshConfig(signal?: AbortSignal): Promise<string> {
    const config = await this.runGh(['codespace', 'ssh', '--config'], signal)
    const { mkdir, readFile: read, writeFile } = await import('node:fs/promises')
    const sshDir = `${process.env.HOME ?? '/root'}/.ssh`
    await mkdir(sshDir, { recursive: true })
    await writeFile(`${sshDir}/codespaces`, config)
    const userConfig = `${sshDir}/config`
    let existing = ''
    try {
      existing = await read(userConfig, 'utf8')
    } catch {
      // A missing user config is created below.
    }
    if (!existing.includes(GH_SSH_INCLUDE)) {
      await writeFile(userConfig, `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}${GH_SSH_INCLUDE}\n`)
    }
    return config
  }

  private parseFirstHost(config: string): string | undefined {
    const match = /^Host\s+(\S+)$/m.exec(config)
    return match?.[1]
  }

  private localHelperPath(): string {
    return fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-ssh/helper'))
  }

  private async deployHelper(host: string, signal?: AbortSignal): Promise<void> {
    const localHelper = this.localHelperPath()
    await this.runScp(localHelper, `${host}:${REMOTE_HELPER_PATH}`, signal)
    const remoteHash = await this.resolveRemotePath(host, `sha256sum ${REMOTE_HELPER_PATH}`, signal)
    const localHash = await this.localHelperHash()
    if (!remoteHash.includes(localHash)) {
      throw new CodespaceConnectionError(
        'the deployed SSH helper digest differs from the local artifact',
        'HELPER_DEPLOY_FAILED')
    }
  }

  private async resolveRemotePath(host: string, command: string, signal?: AbortSignal): Promise<string> {
    return (await this.runSsh(host, command, signal)).trim()
  }

  private async localHelperHash(): Promise<string> {
    const localHelper = this.localHelperPath()
    return createHash('sha256').update(await readFile(localHelper)).digest('hex')
  }

  private async openSshConnection(config: {
    host: string
    node: string
    helper: string
    helperHash: string
    workspace: string
  }): Promise<SshConnection> {
    this.ctx.plugin(SshConnection, {
      host: config.host,
      node: config.node,
      helper: config.helper,
      helperHash: config.helperHash,
      workspace: config.workspace,
    })
    const connection = this.ctx.ssh
    await connection.ready
    return connection
  }

  private async startHarness(
    host: string,
    state: CodespacesWorkspaceState,
    signal?: AbortSignal,
  ): Promise<{ port: number; token: string }> {
    const repoName = state.repository.split('/')[1] ?? 'workspace'
    const command = `cd /workspaces/${repoName} && dsh web --port ${HARNESS_PORT} --no-open --host 127.0.0.1`
    const child = spawn('ssh', ['-F', GH_SSH_CONFIG, '-T', host, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    this.harnessProcess = child
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      this.ctx.logger.info('harness: %s', chunk.trim())
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      this.ctx.logger.warn('harness: %s', chunk.trim())
    })
    const launch = await new Promise<{ port: number; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new CodespaceConnectionError(
          `the remote harness did not print its launch URL within 60 seconds${stderr === '' ? '' : `: ${stderr.slice(-500)}`}`,
          'HARNESS_LAUNCH_FAILED'))
      }, 60_000)
      child.stdout.on('data', (chunk: string) => {
        const match = LAUNCH_URL_PATTERN.exec(chunk) ?? LAUNCH_URL_PATTERN.exec(stdout)
        if (match !== null) {
          clearTimeout(timer)
          resolve({ port: Number(match[1]), token: new URL(`http://127.0.0.1:${match[1]}/`).searchParams.get('token') ?? '' })
        }
      })
      child.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(new CodespaceConnectionError(`the harness process failed to start: ${error.message}`, 'HARNESS_LAUNCH_FAILED'))
      })
    })
    if (launch.token === '') {
      throw new CodespaceConnectionError('the remote harness launch URL carried no session token', 'HARNESS_LAUNCH_FAILED')
    }
    return launch
  }

  private async resolveForwardedUrl(name: string, port: number, signal?: AbortSignal): Promise<URL> {
    try {
      const json = await this.runGh(['codespace', 'ports', '-c', name, '--json', 'remoteUrl,number'], signal)
      const ports = JSON.parse(json) as { remoteUrl?: string; number?: number }[]
      const match = ports.find(entry => entry.number === port)?.remoteUrl ?? ports.find(entry => entry.remoteUrl !== undefined)?.remoteUrl
      if (match !== undefined) return new URL(match)
    } catch {
      // The CLI ports listing is unavailable; the environment variable is the fallback.
    }
    const host = this.currentHost()
    if (host === undefined) {
      throw new CodespaceConnectionError('the SSH connection has no host', 'TRANSPORT')
    }
    const domain = (await this.resolveRemotePath(host, 'echo $GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN', signal)).trim()
    if (domain === '') {
      throw new CodespaceConnectionError(
        'the codespace did not provide the port forwarding domain',
        'ENDPOINT_UNRESOLVED')
    }
    return new URL(`https://${name}-${port}.${domain}`)
  }

  private currentHost(): string | undefined {
    return this.sshHost
  }

  private async runGh(args: string[], signal?: AbortSignal): Promise<string> {
    return await this.runProcess('gh', args, signal)
  }

  private async runScp(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    await this.runProcess('scp', ['-F', GH_SSH_CONFIG, source, destination], signal)
  }

  private async runSsh(host: string, command: string, signal?: AbortSignal): Promise<string> {
    return await this.runProcess('ssh', ['-F', GH_SSH_CONFIG, '-T', host, command], signal)
  }

  private async runProcess(command: string, args: string[], signal?: AbortSignal): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.once('error', (error: Error) => {
        reject(new CodespaceConnectionError(`${command} failed to start: ${error.message}`, 'TRANSPORT'))
      })
      child.once('close', (code: number) => {
        if (code === 0) resolve(stdout)
        else reject(new CodespaceConnectionError(`${command} exited with code ${code}: ${stderr.slice(-500)}`, 'TRANSPORT'))
      })
    })
  }
}

export const name = 'codespaces-connection'

export const inject = ['github', 'codespaces', 'codespacesRegistry'] as const

/**
 * Mount the Codespaces connection service.
 * @param ctx - the host context.
 * @param config - deployment-owned overrides (reserved).
 */
export function apply(ctx: Context, config: Record<string, string> = {}): void {
  ctx.plugin(CodespaceConnection, config)
}

export default CodespaceConnection
