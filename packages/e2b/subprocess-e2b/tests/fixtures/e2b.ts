/**
 * In-memory E2B sandbox stand-in for subprocess-e2b tests: one `e2b` service whose
 * `sandbox` surface answers the remote protocol the adapter drives — the ambient
 * environment probe, the private state directory, the published process-group id
 * and exit code, and a background command that emits base64-framed output.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import { FileNotFoundError } from 'e2b'
import type { CommandResult, CommandStartOpts, WriteInfo } from 'e2b'
import type { E2bRemoteCommand, E2bSandboxOperations, E2bWriteEntry } from '../../src/types.ts'
import { E2B_OUTPUT_COMPLETE_FRAME } from '../../src/output.ts'

/** Remote login home the environment probe reports. */
const REMOTE_HOME = '/home/user'

/** Ambient NUL-delimited environment the sandbox reports, including a credential the adapter must drop. */
const REMOTE_AMBIENT = 'PATH=/usr/bin\0LANG=C.UTF-8\0DEEPSEEK_API_KEY=ambient-secret\0'

/** Process-group id the background wrapper publishes in its state directory. */
const REMOTE_PGID = 4242

function encode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
}

/** Base64 stdout of one foreground control command. */
function success(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' }
}

/** Recorded remote surface plus per-test hooks, reset before every test. */
export const fixture: {
  /** Every command text with the options it ran under, in order. */
  commands: Array<{ cmd: string; opts: CommandStartOpts | undefined }>
  /** Paths and content of every bulk write, in order. */
  writes: Array<{ paths: string[]; data: string }>
  /** Remote paths removed, in order. */
  removed: string[]
  /** Text of the background command the adapter started. */
  started: string | undefined
  /** Environment entries the background command was launched with. */
  startedEnvs: Record<string, string> | undefined
  /** Directory the background command ran in. */
  startedCwd: string | undefined
  /** Bytes the background command writes to stdout, framed by the fixture. */
  stdout: string
  /** Bytes the background command writes to stderr, framed by the fixture. */
  stderr: string
  /** Exit code the background command's wrapper publishes. */
  exitCode: number
  /** Thrown by every `commands.run` call while set. */
  runFailure?: unknown
} = {
  commands: [],
  writes: [],
  removed: [],
  started: undefined,
  startedEnvs: undefined,
  startedCwd: undefined,
  stdout: '',
  stderr: '',
  exitCode: 0,
}

/** Restore the empty remote world and cleared hooks. */
export function resetFixture(): void {
  fixture.commands = []
  fixture.writes = []
  fixture.removed = []
  fixture.started = undefined
  fixture.startedEnvs = undefined
  fixture.startedCwd = undefined
  fixture.stdout = ''
  fixture.stderr = ''
  fixture.exitCode = 0
  remoteFiles.clear()
  stateDir = undefined
  delete fixture.runFailure
}

/** Remote files the fixture holds, keyed by normalized absolute path. */
const remoteFiles = new Map<string, string>()

/** State directory the adapter reserved, learned from the paths it wrote. */
let stateDir: string | undefined

function put(path: string, content: string): void {
  remoteFiles.set(posix.normalize(path), content)
}

/** One background command handle answering the adapter's settle and teardown calls. */
class FakeCommand implements E2bRemoteCommand {
  readonly pid = REMOTE_PGID
  readonly stdout = ''
  /** Whether the adapter ever asked this command to die. */
  killed = false
  /** Whether the adapter stopped event delivery before settlement. */
  disconnected = false

  private readonly settled = Promise.withResolvers<CommandResult>()

  constructor(private readonly deliver: { stdout?: (data: string) => void | Promise<void>; stderr?: (data: string) => void | Promise<void> }) {}

  wait(): Promise<CommandResult> {
    return this.settled.promise
  }

  async kill(): Promise<boolean> {
    this.killed = true
    this.settled.resolve({ exitCode: 137, stdout: '', stderr: '' })
    return true
  }

  async sendStdin(): Promise<void> {}

  async closeStdin(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.disconnected = true
  }

  /** Deliver framed output, then settle with the published exit code. */
  async publish(): Promise<void> {
    await emitFrames(this.deliver.stdout, fixture.stdout)
    await emitFrames(this.deliver.stderr, fixture.stderr)
    this.settled.resolve({ exitCode: fixture.exitCode, stdout: '', stderr: '' })
  }
}

/** Deliver base64 frames and the EOF marker, as the remote encoder does. */
async function emitFrames(
  deliver: ((data: string) => void | Promise<void>) | undefined,
  text: string,
): Promise<void> {
  if (deliver === undefined) return
  const frames = text.length === 0
    ? E2B_OUTPUT_COMPLETE_FRAME
    : `${Buffer.from(text, 'utf-8').toString('base64')}\n${E2B_OUTPUT_COMPLETE_FRAME}`
  await deliver(`${frames}\n`)
}

const commands = {
  async run(cmd: string, opts?: CommandStartOpts): Promise<E2bRemoteCommand | CommandResult> {
    if (fixture.runFailure !== undefined) throw fixture.runFailure
    fixture.commands.push({ cmd, opts })
    if (cmd.includes('env -0')) return success(`${encode(REMOTE_HOME)}\n${encode(REMOTE_AMBIENT)}\n`)
    if (opts?.background !== true) return success()
    if (stateDir === undefined) throw new Error('subprocess-e2b fixture: background start preceded the state directory write')
    fixture.started = cmd
    fixture.startedEnvs = opts.envs
    fixture.startedCwd = opts.cwd
    // The wrapper publishes its process-group id and exit code before the adapter reads them.
    put(posix.join(stateDir, 'pid'), `${REMOTE_PGID}\n`)
    put(posix.join(stateDir, 'exit-code'), `${fixture.exitCode}\n`)
    const command = new FakeCommand({
      stdout: opts.onStdout as ((data: string) => void | Promise<void>) | undefined,
      stderr: opts.onStderr as ((data: string) => void | Promise<void>) | undefined,
    })
    void command.publish()
    return command
  },
}

const files = {
  async read(path: string): Promise<string> {
    const normalized = posix.normalize(path)
    const content = remoteFiles.get(normalized)
    if (content === undefined) throw new FileNotFoundError(`File "${normalized}" not found`)
    return content
  },

  async write(entries: E2bWriteEntry[]): Promise<WriteInfo[]> {
    fixture.writes.push({
      paths: entries.map(entry => entry.path),
      data: entries.map(entry => (typeof entry.data === 'string' ? entry.data : '')).join(' '),
    })
    for (const entry of entries) {
      if (posix.basename(entry.path) === 'pid') stateDir = posix.dirname(posix.normalize(entry.path))
      put(entry.path, typeof entry.data === 'string' ? entry.data : '')
    }
    return entries.map(entry => ({ path: entry.path, name: posix.basename(entry.path) }))
  },

  async makeDir(): Promise<boolean> {
    return true
  },

  async remove(path: string): Promise<void> {
    const normalized = posix.normalize(path)
    fixture.removed.push(normalized)
    remoteFiles.delete(normalized)
  },
}

const pty = {
  async create(): Promise<E2bRemoteCommand> {
    throw new Error('subprocess-e2b fixture: PTY allocation is not modeled')
  },

  async sendInput(): Promise<void> {},

  async resize(): Promise<void> {},
}

const sandbox: E2bSandboxOperations = { commands, files, pty }

/** The `e2b` service seam: a fixed workspace and the fake remote world. */
export class FixtureE2b extends Service {
  constructor(ctx: Context) {
    super(ctx, 'e2b')
  }

  /** Workspace directory every spawned command starts from. */
  readonly workspace = '/workspace/e2b'

  /** Sandbox handle exposing the command, file, and terminal surfaces. */
  readonly sandbox = sandbox
}

export default FixtureE2b
