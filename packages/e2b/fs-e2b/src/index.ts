/** Filesystem provider over the E2B sandbox owned by `ctx.e2b`: one POSIX world with remote metadata and mutations. */

import { posix } from 'node:path'
import { TextDecoder } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { FileNotFoundError, FileType } from 'e2b'
import type { EntryInfo, Filesystem } from 'e2b'
import {
  BINARY_SAMPLE_BYTES,
  DEFAULT_DIFF_BASIS_MAX_BYTES,
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
  TargetLocks,
  applyLiteralEdit,
  assertDiffBasisMaxBytes,
  assertTextualBytes,
  decodeUtf8Chunk,
  decodeUtf8Text,
  detectLineEndings,
  normalizeLineEndings,
  restoreLineEndings,
} from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-e2b'

/** Configuration for the E2B filesystem backend. */
export interface Config {
  /** Base directory for relative paths inside the sandbox. Defaults to the connection workspace. */
  cwd?: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side, capped by the
   * runtime's safe allocation/decode maximum. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
}

type ResolvedConfig = Required<Config>

/** POSIX resolves at most 40 symbolic links per lookup before reporting a cycle. */
const MAX_SYMLINK_HOPS = 40

/** Failure verbs shared by SDK error translation and guard messages. */
type Verb = 'read' | 'write' | 'edit' | 'list' | 'stat'

/**
 * Absolute display spelling for a requested path: preserves physical `..`
 * segments the way the local backend does and collapses other spellings.
 * @param cwd - absolute base directory for relative paths.
 * @param path - the requested path, absolute or relative to `cwd`.
 * @returns the display path as spelled for caller-facing output.
 */
function e2bDisplayPath(cwd: string, path: string): string {
  const raw = posix.isAbsolute(path) ? path : `${cwd}/${path}`
  return /(?:^|\/)\.\.(?:\/|$)/u.test(raw) ? raw : posix.resolve(cwd, path)
}

/**
 * Opaque freshness token from the sandbox entry's modification time, size, and mode.
 * @param info - the entry metadata a probe returned.
 * @returns the version guarding the next write or edit.
 */
function versionOf(info: EntryInfo): FsVersion {
  return FsVersion(`${info.modifiedTime?.getTime() ?? 0}:${info.size}:${info.mode}`)
}

/**
 * Metadata type of a followed object.
 * @param type - the sandbox entry type, when the sandbox reported one.
 * @returns the seam's file/directory/other classification.
 */
function entryKind(type: EntryInfo['type']): FsInfo['type'] {
  if (type === FileType.FILE) return 'file'
  if (type === FileType.DIR) return 'directory'
  return 'other'
}

/**
 * Metadata type of a path entry without following it.
 * @param type - the sandbox entry type, when the sandbox reported one.
 * @returns the seam's file/directory/symlink/other classification.
 */
function pathKind(type: EntryInfo['type']): FsPathInfo['type'] {
  if (type === FileType.FILE) return 'file'
  if (type === FileType.DIR) return 'directory'
  if (type === FileType.SYMLINK) return 'symlink'
  return 'other'
}

/**
 * The E2B filesystem backend. `resolve()` follows symbolic links so aliases
 * share one identity, and versions come from sandbox metadata, so a rewrite in
 * the same millisecond with the same size and mode can read as unchanged.
 */
export class E2bFileSystem extends FileSystem {
  static inject = ['e2b']

  /** Loader defaults and bounds for this backend. */
  static Config: schema<Config> = schema.object({
    cwd: schema.string(),
    diffBasisMaxBytes: schema.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  })

  /** Validated config after resolving the connection workspace default. */
  readonly config: ResolvedConfig
  /** Per-target FIFO locks: the read→guard→write window cannot interleave. */
  private readonly locks = new TargetLocks()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    assertDiffBasisMaxBytes(resolved.diffBasisMaxBytes, 'fs-e2b')
    const cwd = config.cwd ?? ctx.e2b.workspace
    if (!posix.isAbsolute(cwd)) throw new Error(`fs-e2b: cwd must be an absolute sandbox path, got "${cwd}"`)
    this.config = { cwd, diffBasisMaxBytes: resolved.diffBasisMaxBytes }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const signal = opts?.signal
    if (signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const displayPath = this.displayFor(path, opts?.cwd)
    const found = await this.chase(displayPath, displayPath, signal)
    const targetKey = found === undefined ? await this.repair(displayPath, signal) : found.path
    return { targetKey: FsTargetKey(targetKey), displayPath }
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const found = await this.chase(target.targetKey, target.displayPath, signal)
    if (found === undefined) return undefined
    return { version: versionOf(found.info), type: entryKind(found.info.type), size: found.info.size }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const displayPath = this.displayFor(path, opts?.cwd)
    const info = await this.probe(displayPath, displayPath, signal)
    if (info === undefined) return undefined
    return { version: versionOf(info), type: pathKind(info.type), size: info.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.requireFile(target, signal)
    const bytes = await this.call('read', target.displayPath, signal, (opts) => {
      return this.files.read(target.targetKey, { ...opts, format: 'bytes' })
    })
    assertTextualBytes(bytes, 'read', target.displayPath, BINARY_SAMPLE_BYTES)
    return decodeUtf8Text(bytes, 'read', target.displayPath)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.streamTextInternal(target, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const info = await this.requireFile(target, signal)
    if (info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const window = await this.readWindow(target, signal, 0, maxBytes + 1)
    if (window.length > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    return window
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    await this.requireFile(target, signal)
    return await this.readWindow(target, signal, range.offset, range.length)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (signal?.aborted) throw new FsError('list aborted', 'FS_ABORTED')
    const found = await this.chase(target.targetKey, target.displayPath, signal)
    if (found === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (found.info.type !== FileType.DIR) {
      throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    }
    const entries = await this.call('list', target.displayPath, signal, opts => this.files.list(found.path, opts))
    const result: FsDirEntry[] = []
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const childDisplay = e2bDisplayPath(target.displayPath, entry.name)
      const chased = await this.chase(childDisplay, childDisplay, signal)
      const info = chased?.info
      const key = chased === undefined ? await this.repair(childDisplay, signal) : chased.path
      result.push({
        name: entry.name,
        type: info === undefined ? 'other' : entryKind(info.type),
        target: { targetKey: FsTargetKey(key), displayPath: childDisplay },
        ...info === undefined ? {} : { version: versionOf(info) },
        ...info?.type === FileType.FILE ? { size: info.size } : {},
      })
    }
    return result
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
    return this.locks.run(target.targetKey, async () => {
      const existing = await this.chase(target.targetKey, target.displayPath, signal)
      if (existing !== undefined && existing.info.type !== FileType.FILE) {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      if (expected?.kind === 'replaceIfVersion') {
        if (existing === undefined) {
          throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        }
        if (versionOf(existing.info) !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(
          `cannot overwrite existing "${target.displayPath}" without reading it first`,
          'FS_NOT_OBSERVED',
        )
      }

      const diffable = existing !== undefined
        && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
      const before = diffable ? await this.diffBasis(target, existing.info, signal) : null
      await this.call('write', target.displayPath, signal, (opts) => {
        return this.files.write(target.targetKey, content, opts)
      })
      const after = await this.chase(target.targetKey, target.displayPath, signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: this.versionAfterWrite(after, target),
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    if (signal?.aborted) throw new FsError('edit aborted', 'FS_ABORTED')
    return this.locks.run(target.targetKey, async () => {
      const existing = await this.chase(target.targetKey, target.displayPath, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (existing.info.type !== FileType.FILE) {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && versionOf(existing.info) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const bytes = await this.call('edit', target.displayPath, signal, (opts) => {
        return this.files.read(target.targetKey, { ...opts, format: 'bytes' })
      })
      assertTextualBytes(bytes, 'edit', target.displayPath)
      const raw = decodeUtf8Text(bytes, 'edit', target.displayPath)
      const content = normalizeLineEndings(raw)
      const lineEndings = detectLineEndings(raw)
      const edited = applyLiteralEdit(content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      await this.call('write', target.displayPath, signal, (opts) => {
        return this.files.write(target.targetKey, restoreLineEndings(edited.content, lineEndings), opts)
      })
      const after = await this.chase(target.targetKey, target.displayPath, signal)
      return {
        version: this.versionAfterWrite(after, target),
        before: content,
        after: edited.content,
      }
    })
  }

  /** Absolute display spelling for a requested path; empty input is not a path. */
  private displayFor(path: string, cwd?: string): string {
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const base = cwd === undefined ? this.config.cwd : posix.resolve(this.config.cwd, cwd)
    return e2bDisplayPath(base, path)
  }

  /**
   * Follow the final symbolic links at `path`, adopting the server's absolute
   * spelling at each step so alias spellings collapse to one identity.
   * @param path - absolute path to inspect.
   * @param displayPath - caller-facing path used in failure messages.
   * @param signal - aborts each metadata request.
   * @returns the followed path and its metadata, or undefined when the path — or a link target — is absent.
   */
  private async chase(
    path: string,
    displayPath: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; info: EntryInfo } | undefined> {
    let current = path
    for (let hops = 0; ; hops++) {
      const info = await this.probe(current, displayPath, signal)
      if (info === undefined) return undefined
      if (posix.isAbsolute(info.path)) current = info.path
      if (info.type !== FileType.SYMLINK) return { path: current, info }
      const link = info.symlinkTarget
      if (link === undefined) return { path: current, info }
      if (hops >= MAX_SYMLINK_HOPS) {
        throw new FsError(`cannot resolve "${displayPath}": too many levels of symbolic links`, 'FS_IO_ERROR')
      }
      const next = posix.resolve(posix.dirname(current), link)
      if (next === current) throw new FsError(`cannot resolve "${displayPath}": symbolic link cycle`, 'FS_IO_ERROR')
      current = next
    }
  }

  /**
   * Read one entry's metadata, treating sandbox-side absence as undefined.
   * @param path - absolute path to inspect.
   * @param displayPath - caller-facing path used in failure messages.
   * @param signal - aborts the request.
   * @returns the entry metadata, or undefined when the sandbox reports it missing.
   */
  private async probe(path: string, displayPath: string, signal?: AbortSignal): Promise<EntryInfo | undefined> {
    let info: EntryInfo
    try {
      info = await this.files.getInfo(path, signal === undefined ? {} : { signal })
    } catch (error: unknown) {
      if (error instanceof FileNotFoundError) return undefined
      throw this.translate(error, 'stat', displayPath, signal)
    }
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    return info
  }

  /**
   * Resolve an absent path through its nearest existing directory ancestor,
   * appending the missing suffix so the key stays stable across creation.
   * @param displayPath - the absent absolute path.
   * @param signal - aborts each ancestor metadata request.
   * @returns the stable target key for the absent path.
   */
  private async repair(displayPath: string, signal?: AbortSignal): Promise<FsTargetKey> {
    const missing = [posix.basename(displayPath)]
    let ancestor = posix.dirname(displayPath)
    for (;;) {
      const found = await this.chase(ancestor, displayPath, signal)
      if (found === undefined) {
        const parent = posix.dirname(ancestor)
        if (parent === ancestor) return FsTargetKey(displayPath)
        missing.unshift(posix.basename(ancestor))
        ancestor = parent
        continue
      }
      if (found.info.type !== FileType.DIR) {
        throw new FsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
      }
      return FsTargetKey(posix.join(found.path, ...missing))
    }
  }

  /** Filesystem surface of the sandbox this connection owns. */
  private get files(): Filesystem {
    return this.ctx.e2b.sandbox.files
  }

  /**
   * Run one SDK filesystem request and translate its failure into the seam's taxonomy.
   * @param verb - operation name used in failure messages.
   * @param displayPath - caller-facing path used in failure messages.
   * @param signal - cancels the request; an aborted signal reports `FS_ABORTED`.
   * @param run - issues the SDK request with the caller's cancellation.
   * @returns the SDK result.
   */
  private async call<T>(
    verb: Verb,
    displayPath: string,
    signal: AbortSignal | undefined,
    run: (opts: { signal?: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
    try {
      return await run(signal === undefined ? {} : { signal })
    } catch (error: unknown) {
      throw this.translate(error, verb, displayPath, signal)
    }
  }

  /**
   * Translate one failed SDK request: caller cancellation wins, then absence, then I/O.
   * @param error - the rejection from the SDK call.
   * @param verb - operation name used in failure messages.
   * @param displayPath - caller-facing path used in failure messages.
   * @param signal - the caller's signal for this request.
   * @returns the equivalent filesystem failure.
   */
  private translate(error: unknown, verb: Verb, displayPath: string, signal?: AbortSignal): FsError {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return new FsError(`${verb} aborted`, 'FS_ABORTED')
    }
    if (error instanceof FileNotFoundError) {
      return new FsError(`cannot ${verb} "${displayPath}": not found`, 'FS_NOT_FOUND')
    }
    const message = error instanceof Error ? error.message : String(error)
    return new FsError(`cannot ${verb} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error })
  }

  /**
   * Require a regular file at the target before a read.
   * @param target - the resolved target to check.
   * @param signal - aborts the metadata request.
   * @returns the followed file's metadata.
   */
  private async requireFile(target: FsTarget, signal?: AbortSignal): Promise<EntryInfo> {
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    const found = await this.chase(target.targetKey, target.displayPath, signal)
    if (found === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (found.info.type !== FileType.FILE) {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    return found.info
  }

  /** Stream a regular file as decoded text chunks, rejecting binary and invalid UTF-8. */
  private async streamTextInternal(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.requireFile(target, signal)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const displayPath = target.displayPath
    const chunks = this.byteStream(target, displayPath, signal)
    return (async function* () {
      let sampled = 0
      for await (const chunk of chunks) {
        if (sampled < BINARY_SAMPLE_BYTES) {
          const sample = chunk.subarray(0, BINARY_SAMPLE_BYTES - sampled)
          assertTextualBytes(sample, 'read', displayPath)
          sampled += sample.length
        }
        yield decodeUtf8Chunk(decoder, chunk, 'read', displayPath)
      }
      yield decodeUtf8Chunk(decoder, undefined, 'read', displayPath)
    })()
  }

  /**
   * Raw byte chunks of a regular file through the SDK stream, canceling the
   * source when the consumer stops early or a bound is reached.
   * @param target - the resolved file to stream.
   * @param displayPath - caller-facing path used in failure messages.
   * @param signal - aborts between chunks (`FS_ABORTED`).
   * @returns the chunk generator in file order.
   */
  private async *byteStream(
    target: FsTarget,
    displayPath: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const stream = await this.call('read', displayPath, signal, (opts) => {
      return this.files.read(target.targetKey, { ...opts, format: 'stream' })
    })
    const reader = stream.getReader()
    let finished = false
    try {
      while (true) {
        if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
        const { done, value } = await reader.read()
        if (done) {
          finished = true
          return
        }
        if (value.length > 0) yield value
      }
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      throw this.translate(error, 'read', displayPath, signal)
    } finally {
      if (finished) {
        reader.releaseLock()
      } else {
        // Abandoned before the end; a failed cancel cannot change bytes already yielded.
        await reader.cancel().catch(() => undefined)
      }
    }
  }

  /**
   * Read at most `length` bytes from `offset` of a regular file; the bound is
   * enforced on the stream so a growing file is never held whole.
   * @param target - the resolved file to read.
   * @param signal - aborts between chunks.
   * @param offset - 0-based first byte to keep.
   * @param length - largest byte count to keep; zero or less returns empty.
   * @returns the window's bytes, at most `length` long.
   */
  private async readWindow(
    target: FsTarget,
    signal: AbortSignal | undefined,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0)
    const parts: Uint8Array[] = []
    let kept = 0
    let seen = 0
    for await (const chunk of this.byteStream(target, target.displayPath, signal)) {
      let from = 0
      if (seen < offset) from = Math.min(chunk.length, offset - seen)
      seen += chunk.length
      if (from >= chunk.length) continue
      const take = Math.min(chunk.length - from, length - kept)
      parts.push(chunk.subarray(from, from + take))
      kept += take
      if (kept >= length) break
    }
    const window = new Uint8Array(kept)
    let at = 0
    for (const part of parts) {
      window.set(part, at)
      at += part.length
    }
    return window
  }

  /**
   * Best-effort overwrite diff basis: `null` when the prior file is missing,
   * over the limit, binary, invalid UTF-8, or unreadable — only cancellation
   * propagates, because the basis is presentation-only.
   * @param target - the file about to be overwritten.
   * @param prior - the pre-write metadata already probed for the guard.
   * @param signal - aborts the basis read (`FS_ABORTED`).
   * @returns the LF-normalized prior text, or null when no basis is available.
   */
  private async diffBasis(target: FsTarget, prior: EntryInfo, signal?: AbortSignal): Promise<string | null> {
    if (prior.size >= this.config.diffBasisMaxBytes) return null
    try {
      const bytes = await this.call('read', target.displayPath, signal, (opts) => {
        return this.files.read(target.targetKey, { ...opts, format: 'bytes' })
      })
      if (bytes.length >= this.config.diffBasisMaxBytes) return null
      assertTextualBytes(bytes, 'read', target.displayPath)
      return normalizeLineEndings(decodeUtf8Text(bytes, 'read', target.displayPath))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_ABORTED') throw error
      return null
    }
  }

  /**
   * Version of a file just written; a vanished post-write probe falls back to a sentinel.
   * @param after - the post-write probe, when it still found the file.
   * @param target - the written target.
   * @returns the fresh version token.
   */
  private versionAfterWrite(after: { path: string; info: EntryInfo } | undefined, target: FsTarget): FsVersion {
    if (after === undefined) return FsVersion(`missing:${target.targetKey}`)
    return versionOf(after.info)
  }
}

export default E2bFileSystem
