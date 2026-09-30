/**
 * Narrow E2B operation surfaces the subprocess adapter drives. The SDK's
 * concrete `Sandbox`/`CommandHandle` classes carry private state the seam
 * never touches; these declarations pin the exact operations used so provider
 * fakes stay structurally assignable without casts.
 * @module
 */

import type {
  CommandRequestOpts,
  CommandResult,
  CommandStartOpts,
  ConnectionOpts,
  FilesystemReadOpts,
  FilesystemWriteOpts,
  WriteInfo,
} from 'e2b'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/**
 * Deadline and cancellation attached to one SDK request. The SDK keeps these
 * shapes internal, so each narrow operation restates them structurally.
 */
export type E2bRequestOpts = Pick<ConnectionOpts, 'requestTimeoutMs' | 'signal'>

/** One file's remote destination and content for a bulk write. */
export interface E2bWriteEntry {
  /** Absolute remote path. */
  path: string
  /** File content delivered as one entry. */
  data: string | ArrayBuffer | Blob | ReadableStream
}

/** PTY allocation request: session dimensions, bootstrap context, and output delivery. */
export interface E2bPtyCreateOpts extends E2bRequestOpts {
  /** Column count of the new session. */
  cols: number
  /** Row count of the new session. */
  rows: number
  /** Receives every output chunk from the new session. */
  onData: (data: Uint8Array) => void | Promise<void>
  /** Session startup deadline; `0` waits without a session-level timeout. */
  timeoutMs?: number
  /** Explicit environment entries for the bootstrap shell. */
  envs?: Record<string, string>
  /** Working directory of the bootstrap shell. */
  cwd?: string
}

/** One remote command or PTY session the adapter can wait on, kill, and feed. */
export interface E2bRemoteCommand {
  /** Remote process identifier used for PTY input and group-id fallback. */
  readonly pid: number
  /** Stdout collected so far, readable on either start-command settlement. */
  readonly stdout: string
  /**
   * Wait for the command to finish.
   * @returns Exit facts, rejecting with the SDK's exit error on failure.
   */
  wait(): Promise<CommandResult>
  /**
   * Kill the command with `SIGKILL`.
   * @returns Whether the remote process was found and killed.
   */
  kill(): Promise<boolean>
  /**
   * Write bytes to the command's stdin.
   * @param data - Bytes or text to send.
   * @param opts - Optional deadline and cancellation for one SDK request.
   * @returns Settles once the SDK accepts the input.
   */
  sendStdin(data: string | Uint8Array, opts?: CommandRequestOpts): Promise<void>
  /**
   * Close the command's stdin, signalling EOF.
   * @param opts - Optional deadline and cancellation for one SDK request.
   * @returns Settles once the SDK closes the stream.
   */
  closeStdin(opts?: CommandRequestOpts): Promise<void>
  /**
   * Stop SDK event delivery without killing the command.
   * @returns Settles once callbacks will no longer fire.
   */
  disconnect(): Promise<void>
}

/** Remote command execution for one sandbox. */
export interface E2bRemoteCommands {
  /**
   * Run one shell command.
   * @param cmd - Shell text executed through the sandbox's command layer.
   * @param opts - Working directory, environment, cancellation, and background flag.
   * @returns The command handle for a background start, otherwise its result.
   */
  run(cmd: string, opts?: CommandStartOpts): Promise<E2bRemoteCommand | CommandResult>
}

/** Remote filesystem operations for one sandbox. */
export interface E2bRemoteFiles {
  /**
   * Read a file as text.
   * @param path - Absolute remote path.
   * @param opts - Optional deadline and cancellation for one SDK request.
   * @returns The file's UTF-8 content.
   */
  read(path: string, opts?: FilesystemReadOpts): Promise<string>
  /**
   * Write files, creating parent directories as needed.
   * @param files - Remote paths and their content.
   * @param opts - Optional deadline and cancellation for one SDK request.
   * @returns Server-reported identity of each written entry.
   */
  write(files: E2bWriteEntry[], opts?: FilesystemWriteOpts): Promise<WriteInfo[]>
  /**
   * Create a directory and its parents.
   * @param path - Absolute remote directory path.
   * @param opts - Optional deadline and cancellation for one SDK request.
   * @returns Whether the directory was created rather than already present.
   */
  makeDir(path: string, opts?: E2bRequestOpts): Promise<boolean>
  /**
   * Remove a file or directory tree.
   * @param path - Absolute remote path.
   * @param opts - Optional deadline and cancellation for one SDK request.
   * @returns Settles once the remote path is gone.
   */
  remove(path: string, opts?: E2bRequestOpts): Promise<void>
}

/** Remote PTY allocation for one sandbox. */
export interface E2bRemotePty {
  /**
   * Allocate a pseudo-terminal and start its bootstrap shell.
   * @param opts - Dimensions, environment, output callback, and cancellation.
   * @returns Handle for the PTY's leader process.
   */
  create(opts: E2bPtyCreateOpts): Promise<E2bRemoteCommand>
  /**
   * Write bytes to a PTY.
   * @param pid - Remote PTY leader process identifier.
   * @param data - Bytes to send as terminal input.
   * @param opts - Optional deadline and cancellation for one SDK request.
   * @returns Settles once the SDK accepts the input.
   */
  sendInput(pid: number, data: Uint8Array, opts?: E2bRequestOpts): Promise<void>
  /**
   * Resize a PTY to new dimensions.
   * @param pid - Remote PTY leader process identifier.
   * @param size - New column and row counts.
   * @param opts - Optional deadline and cancellation for one SDK request.
   * @returns Settles once the remote PTY reflects the new dimensions.
   */
  resize(pid: number, size: { cols: number; rows: number }, opts?: E2bRequestOpts): Promise<void>
}

/** The sandbox operations one remote world exposes to this adapter. */
export interface E2bSandboxOperations {
  /** Shell command execution. */
  readonly commands: E2bRemoteCommands
  /** Filesystem access for private state and exit facts. */
  readonly files: E2bRemoteFiles
  /** Terminal allocation. */
  readonly pty: E2bRemotePty
}

/** Shared E2B sandbox owner: the live operations and the remote workspace directory. */
export interface E2bSandboxOwner {
  /** Operations of the owned remote sandbox; reading it throws while none is owned. */
  readonly sandbox: E2bSandboxOperations
  /** Absolute remote workspace directory this connection starts sessions in. */
  readonly workspace: string
}

/** One registered subprocess whose cleanup disposal must join. */
export interface E2bTrackedSubprocess {
  /** Start the provider's termination procedure; later calls reuse it. */
  terminate(): void
  /**
   * Wait until the managed remote range is quiescent.
   * @param signal - Cancels this wait without claiming exit.
   * @returns Whether quiescence was observed before cancellation.
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
  /** Command outcome, rejecting for spawn or provider failures. */
  readonly done: Promise<SubprocessOutcome>
}
