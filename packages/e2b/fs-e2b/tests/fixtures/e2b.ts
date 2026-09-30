/**
 * In-memory E2B sandbox stand-in for fs-e2b tests: one `e2b` service whose
 * `sandbox.files` surface records every call and accepts failure hooks, plus
 * seeding helpers for the tree. Uses the real SDK error classes so
 * `instanceof` checks in the provider see the same identities.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import { FileNotFoundError, FileType } from 'e2b'
import type { EntryInfo } from 'e2b'

/** Stored filesystem object; `type`/`modifiedTime` may be omitted to model server omissions. */
export interface StoredEntry {
  /** Sandbox-reported object type, when the server reports one. */
  type?: FileType
  /** File bytes; empty for directories and symbolic links. */
  content: Uint8Array
  /** Symbolic-link target, as spelled by the link owner. */
  symlinkTarget?: string
  /** POSIX mode bits used in version tokens. */
  mode: number
  /** Modification time in epoch milliseconds, when the server reports one. */
  mtime?: number
  /** Stream chunk boundaries; defaults to the whole content in one chunk. */
  chunks?: Uint8Array[]
}

/** Per-request options the provider forwards to the SDK. */
interface FileRequestOpts {
  /** Caller cancellation, forwarded verbatim. */
  signal?: AbortSignal
  /** Requested read format, when reading. */
  format?: string
}

/** Recorded SDK surface plus per-test failure hooks, reset before every test. */
export const fixture: {
  /** The sandbox tree keyed by normalized absolute path. */
  files: Map<string, StoredEntry>
  /** Paths and options of every getInfo call, in order. */
  getInfoCalls: Array<{ path: string; opts: FileRequestOpts | undefined }>
  /** Paths and options of every list call, in order. */
  listCalls: Array<{ path: string; opts: FileRequestOpts | undefined }>
  /** Paths and options of every read call, in order. */
  readCalls: Array<{ path: string; opts: FileRequestOpts | undefined }>
  /** Paths, data, and options of every write call, in order. */
  writeCalls: Array<{ path: string; data: string | Uint8Array; opts: FileRequestOpts | undefined }>
  /** Stream cancellations observed by the fake readable. */
  streamCancels: number
  /** Milliseconds added for every write's modification time. */
  clock: number
  /** Rewrites the entry path the fake reports, modeling server normalization. */
  infoPath?: (path: string) => string
  /** Thrown by every getInfo call while set. */
  getInfoFailure?: unknown
  /** Thrown by every list call while set. */
  listFailure?: unknown
  /** Thrown by every read call while set. */
  readFailure?: unknown
  /** Thrown by every write call while set. */
  writeFailure?: unknown
  /** Replaces the bytes of every non-stream read while set. */
  readOverride?: (path: string) => Uint8Array | undefined
  /** Runs after a list builds its entries, before returning them. */
  afterList?: () => void
  /** Runs before every stream pull; may throw to fail the stream or abort the caller. */
  streamPull?: () => void
  /** Paths deleted right after a successful write, modeling a post-write race. */
  dropAfterWrite: Set<string>
} = {
  files: new Map(),
  getInfoCalls: [],
  listCalls: [],
  readCalls: [],
  writeCalls: [],
  streamCancels: 0,
  clock: 1_700_000_000_000,
  dropAfterWrite: new Set(),
}

const CLOCK_START = 1_700_000_000_000

/** Restore the empty tree, empty records, and cleared hooks. */
export function resetFixture(): void {
  fixture.files = new Map()
  fixture.getInfoCalls = []
  fixture.listCalls = []
  fixture.readCalls = []
  fixture.writeCalls = []
  fixture.streamCancels = 0
  fixture.clock = CLOCK_START
  delete fixture.infoPath
  delete fixture.getInfoFailure
  delete fixture.listFailure
  delete fixture.readFailure
  delete fixture.writeFailure
  delete fixture.readOverride
  delete fixture.afterList
  delete fixture.streamPull
  fixture.dropAfterWrite = new Set()
}

/** An aborted-request failure shaped like the SDK's fetch rejection. */
function abortFailure(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

/** Reject one fake operation when its signal is already aborted. */
function guard(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortFailure()
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content.slice()
}

/** Create every missing ancestor directory of `path`. */
function makeDirs(path: string): void {
  const normalized = posix.normalize(path)
  if (normalized === '/' || fixture.files.has(normalized)) return
  makeDirs(posix.dirname(normalized))
  fixture.files.set(normalized, { type: FileType.DIR, content: new Uint8Array(0), mode: 0o755, mtime: fixture.clock })
}

function put(path: string, entry: StoredEntry): void {
  const normalized = posix.normalize(path)
  makeDirs(posix.dirname(normalized))
  fixture.files.set(normalized, entry)
}

/** Build the SDK entry shape for one stored object. */
function toInfo(path: string, stored: StoredEntry): EntryInfo {
  return {
    name: posix.basename(path),
    path: fixture.infoPath === undefined ? path : fixture.infoPath(path),
    size: stored.content.length,
    mode: stored.mode,
    permissions: '----------',
    owner: 'root',
    group: 'root',
    ...stored.type === undefined ? {} : { type: stored.type },
    ...stored.mtime === undefined ? {} : { modifiedTime: new Date(stored.mtime) },
    ...stored.symlinkTarget === undefined ? {} : { symlinkTarget: stored.symlinkTarget },
  }
}

/** Seed a regular file, creating its ancestor directories. */
export function seedFile(
  path: string,
  content: string | Uint8Array,
  opts: { mtime?: number; chunks?: Uint8Array[] } = {},
): void {
  put(path, {
    type: FileType.FILE,
    content: toBytes(content),
    mode: 0o644,
    mtime: opts.mtime ?? CLOCK_START,
    ...opts.chunks === undefined ? {} : { chunks: opts.chunks },
  })
}

/** Seed a directory, creating its ancestor directories. */
export function seedDir(path: string): void {
  put(path, { type: FileType.DIR, content: new Uint8Array(0), mode: 0o755, mtime: CLOCK_START })
}

/** Seed a symbolic link; omit `target` to model a link the sandbox does not describe. */
export function seedSymlink(path: string, target?: string): void {
  put(path, {
    type: FileType.SYMLINK,
    content: new Uint8Array(0),
    mode: 0o777,
    mtime: CLOCK_START,
    ...target === undefined ? {} : { symlinkTarget: target },
  })
}

/** Seed an entry the server describes with neither a type nor a modification time. */
export function seedOpaque(path: string): void {
  put(path, { content: new Uint8Array(0), mode: 0o644 })
}

/** Raw stored bytes of one path, or undefined when absent. */
export function rawContent(path: string): Uint8Array | undefined {
  return fixture.files.get(posix.normalize(path))?.content
}

/** Fake filesystem surface: only the operations the provider drives. */
const files = {
  async getInfo(path: string, opts?: FileRequestOpts): Promise<EntryInfo> {
    guard(opts?.signal)
    fixture.getInfoCalls.push({ path, opts })
    if (fixture.getInfoFailure !== undefined) throw fixture.getInfoFailure
    const normalized = posix.normalize(path)
    const stored = fixture.files.get(normalized)
    if (stored === undefined) throw new FileNotFoundError(`File "${normalized}" not found`)
    return toInfo(normalized, stored)
  },

  async list(path: string, opts?: FileRequestOpts): Promise<EntryInfo[]> {
    guard(opts?.signal)
    fixture.listCalls.push({ path, opts })
    if (fixture.listFailure !== undefined) throw fixture.listFailure
    const normalized = posix.normalize(path)
    const stored = fixture.files.get(normalized)
    if (stored === undefined) throw new FileNotFoundError(`File "${normalized}" not found`)
    const entries = [...fixture.files.entries()]
      .filter(([child]) => posix.dirname(child) === normalized)
      .map(([child, value]) => toInfo(child, value))
    fixture.afterList?.()
    return entries
  },

  async read(path: string, opts?: FileRequestOpts): Promise<Uint8Array | ReadableStream<Uint8Array>> {
    guard(opts?.signal)
    fixture.readCalls.push({ path, opts })
    if (fixture.readFailure !== undefined) throw fixture.readFailure
    const normalized = posix.normalize(path)
    const stored = fixture.files.get(normalized)
    if (stored === undefined) throw new FileNotFoundError(`File "${normalized}" not found`)
    if (stored.type === FileType.DIR) throw new Error(`Cannot read directory "${normalized}"`)
    if (opts?.format === 'stream') return makeStream(stored)
    return fixture.readOverride?.(normalized) ?? stored.content.slice()
  },

  async write(path: string, data: string | Uint8Array, opts?: FileRequestOpts): Promise<EntryInfo> {
    guard(opts?.signal)
    fixture.writeCalls.push({ path, data, opts })
    if (fixture.writeFailure !== undefined) throw fixture.writeFailure
    const normalized = posix.normalize(path)
    makeDirs(posix.dirname(normalized))
    const prior = fixture.files.get(normalized)
    fixture.clock += 1000
    const stored: StoredEntry = {
      type: FileType.FILE,
      content: toBytes(data),
      mode: prior?.mode ?? 0o644,
      mtime: fixture.clock,
    }
    fixture.files.set(normalized, stored)
    const info = toInfo(normalized, stored)
    if (fixture.dropAfterWrite.has(normalized)) fixture.files.delete(normalized)
    return info
  },
}

/** Build a pull-driven readable over the entry's chunks. */
function makeStream(stored: StoredEntry): ReadableStream<Uint8Array> {
  const chunks = stored.chunks ?? [stored.content]
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      fixture.streamPull?.()
      const chunk = chunks[index++]
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
    },
    cancel() {
      fixture.streamCancels++
    },
  })
}

/** The `e2b` service seam: a fixed workspace and the fake sandbox filesystem. */
export class FixtureE2b extends Service {
  constructor(ctx: Context) {
    super(ctx, 'e2b')
  }

  /** Workspace directory every relative path in this fixture resolves against. */
  readonly workspace = '/workspace/e2b'

  /** Sandbox handle exposing only the filesystem surface the provider drives. */
  readonly sandbox = { files }
}

export default FixtureE2b
