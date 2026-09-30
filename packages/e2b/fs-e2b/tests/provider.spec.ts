/**
 * Tests for the E2B backend through the `ctx.fs` Service Definition: target
 * identity through symlinks and absent paths, metadata probes, whole/ranged/
 * streamed reads, sorted listings, guarded atomic writes with a bounded diff
 * basis, version-guarded literal edits, error translation, and signal handling
 * against the in-memory sandbox fixture.
 */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { constants as bufferConstants } from 'node:buffer'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileNotFoundError } from 'e2b'
import { BINARY_SAMPLE_BYTES, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import { E2bFileSystem } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import {
  FixtureE2b,
  fixture,
  rawContent,
  resetFixture,
  seedDir,
  seedFile,
  seedOpaque,
  seedSymlink,
} from './fixtures/e2b.ts'

const WORKSPACE = '/workspace/e2b'
const MAX_DIFF_BASIS_BYTES = Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH)

let ctx: Context
let fs: E2bFileSystem
let fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []

async function mount(config?: Config): Promise<void> {
  ctx = new Context()
  fibers = [await ctx.plugin(FixtureE2b), await ctx.plugin(E2bFileSystem, config ?? {})]
  fs = ctx.fs as E2bFileSystem
}

async function remount(config: Config): Promise<void> {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  fibers = []
  await mount(config)
}

beforeEach(async () => {
  resetFixture()
  await mount()
})
afterEach(async () => {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  fibers = []
})

/** The version the backend currently reports for a resolved target. */
async function versionOf(target: FsTarget): Promise<FsVersion> {
  const info = await fs.stat(target)
  if (info === undefined) throw new Error('expected target to exist')
  return info.version
}

/** Drain an async text stream into one string. */
async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

/** One listing entry by name, failing when the listing omitted it. */
function requireEntry(entries: FsDirEntry[], name: string): FsDirEntry {
  const entry = entries.find(candidate => candidate.name === name)
  if (entry === undefined) throw new Error(`expected a "${name}" entry`)
  return entry
}

describe('registration', () => {
  it('defaults cwd to the connection workspace and the diff limit to 10 MiB', async () => {
    expect(fs.config).toEqual({ cwd: WORKSPACE, diffBasisMaxBytes: 10 * 1024 * 1024 })
  })

  it('accepts an explicit cwd and diff-basis limit', async () => {
    await remount({ cwd: '/data', diffBasisMaxBytes: 4096 })
    expect(fs.config).toEqual({ cwd: '/data', diffBasisMaxBytes: 4096 })
    seedFile('/data/x.txt', 'in data')
    expect(await fs.readText(await fs.resolve('x.txt'))).toBe('in data')
  })

  it('rejects a relative cwd', async () => {
    const invalid = new Context()
    const service = await invalid.plugin(FixtureE2b)
    onTestFinished(() => service.dispose())
    await expect(invalid.plugin(E2bFileSystem, { cwd: 'relative/path' }))
      .rejects.toThrow('fs-e2b: cwd must be an absolute sandbox path, got "relative/path"')
  })

  it('rejects non-positive, fractional, unsafe, or unallocatable diff-basis limits', async () => {
    const valid = new Context()
    const validService = await valid.plugin(FixtureE2b)
    onTestFinished(() => validService.dispose())
    const validFiber = await valid.plugin(E2bFileSystem, { diffBasisMaxBytes: MAX_DIFF_BASIS_BYTES })
    onTestFinished(() => validFiber.dispose())
    expect((valid.fs as E2bFileSystem).config.diffBasisMaxBytes).toBe(MAX_DIFF_BASIS_BYTES)

    for (const diffBasisMaxBytes of [0, -1, 1.5, MAX_DIFF_BASIS_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = new Context()
      const service = await invalid.plugin(FixtureE2b)
      onTestFinished(() => service.dispose())
      await expect(invalid.plugin(E2bFileSystem, { diffBasisMaxBytes })).rejects.toThrow(
        `fs-e2b: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`,
      )
    }
  })

  it('stays pending without the e2b connection and never registers fs', async () => {
    const bare = new Context()
    onTestFinished(() => bare.fiber.dispose())
    const fiber = await bare.plugin(E2bFileSystem)
    onTestFinished(() => fiber.dispose())
    expect(bare.get('fs')).toBeUndefined()
  })
})

describe('resolve', () => {
  it('resolves a relative path against the configured workspace', async () => {
    seedFile(`${WORKSPACE}/a.txt`, 'A')
    const target = await fs.resolve('a.txt')
    expect(target.displayPath).toBe(`${WORKSPACE}/a.txt`)
    expect(fs.processPath(target)).toBe(`${WORKSPACE}/a.txt`)
    expect(await fs.readText(target)).toBe('A')
  })

  it('keeps a physical .. spelling while adopting the sandbox-normalized key', async () => {
    seedFile(`${WORKSPACE}/file.txt`, 'ok')
    const target = await fs.resolve('sub/../file.txt')
    expect(target.displayPath).toBe(`${WORKSPACE}/sub/../file.txt`)
    expect(fs.processPath(target)).toBe(`${WORKSPACE}/file.txt`)
    expect(await fs.readText(target)).toBe('ok')
  })

  it('resolves relative paths against opts.cwd and ignores opts.cwd for absolute paths', async () => {
    seedFile('/other/x.txt', 'in other')
    const viaOther = await fs.resolve('x.txt', { cwd: '/other' })
    expect(await fs.readText(viaOther)).toBe('in other')
    seedFile(`${WORKSPACE}/abs.txt`, 'absolute')
    const absolute = await fs.resolve(`${WORKSPACE}/abs.txt`, { cwd: '/nonexistent-base' })
    expect(await fs.readText(absolute)).toBe('absolute')
  })

  it('repairs an absent path through its nearest existing directory', async () => {
    const target = await fs.resolve('missing/new.txt')
    expect(fs.processPath(target)).toBe(`${WORKSPACE}/missing/new.txt`)
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('repairs an absent path through a symlinked ancestor', async () => {
    seedDir(`${WORKSPACE}/real`)
    seedSymlink(`${WORKSPACE}/link`, 'real')
    const target = await fs.resolve('link/f.txt')
    expect(fs.processPath(target)).toBe(`${WORKSPACE}/real/f.txt`)
  })

  it('resolves a symbolic link the sandbox does not describe as itself', async () => {
    seedSymlink(`${WORKSPACE}/plain-link`)
    const target = await fs.resolve('plain-link')
    expect(fs.processPath(target)).toBe(`${WORKSPACE}/plain-link`)
    expect(await fs.stat(target)).toMatchObject({ type: 'other' })
  })

  it('rejects a symbolic link cycle', async () => {
    seedSymlink(`${WORKSPACE}/self`, 'self')
    await expect(fs.resolve('self')).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot resolve "${WORKSPACE}/self": symbolic link cycle`,
    })
  })

  it('rejects a symbolic link chain longer than the POSIX hop limit', async () => {
    for (let hop = 0; hop <= 40; hop++) seedSymlink(`${WORKSPACE}/hop${hop}`, `hop${hop + 1}`)
    await expect(fs.resolve('hop0')).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot resolve "${WORKSPACE}/hop0": too many levels of symbolic links`,
    })
  })

  it('rejects a path whose parent segment is a regular file', async () => {
    seedFile(`${WORKSPACE}/a.txt`, 'a')
    await expect(fs.resolve('a.txt/child.txt')).rejects.toMatchObject({
      code: 'FS_NOT_FOUND',
      message: `cannot resolve "${WORKSPACE}/a.txt/child.txt": a parent path segment is not a directory`,
    })
  })

  it('returns the requested path when the sandbox reports a relative entry path', async () => {
    seedFile(`${WORKSPACE}/rel.txt`, 'relative')
    fixture.infoPath = path => posix.basename(path)
    const target = await fs.resolve('rel.txt')
    expect(fs.processPath(target)).toBe(`${WORKSPACE}/rel.txt`)
  })

  it('repairs a path whose ancestors are all missing', async () => {
    const target = await fs.resolve('/nowhere/deep/file.txt')
    expect(fs.processPath(target)).toBe('/nowhere/deep/file.txt')
  })

  it('rejects an empty path', async () => {
    await expect(fs.resolve('   ')).rejects.toMatchObject({
      code: 'FS_NOT_FOUND',
      message: 'file_path must be a non-empty string',
    })
  })

  it('honors a pre-aborted signal', async () => {
    await expect(fs.resolve('a.txt', { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'FS_ABORTED', message: 'resolve aborted' })
  })

  it('honors a signal aborted while resolution is in flight', async () => {
    seedFile(`${WORKSPACE}/a.txt`, 'A')
    const controller = new AbortController()
    const pending = fs.resolve('a.txt', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})

describe('identity helpers', () => {
  it('projects process paths, file URLs, and canonical containment', async () => {
    seedFile(`${WORKSPACE}/nested/file.txt`, 'text')
    const root = await fs.resolve('.')
    const child = await fs.resolve('nested/file.txt')
    const outside = await fs.resolve('..')
    expect(fs.processPath(root)).toBe(WORKSPACE)
    expect(fs.fileUrl(child)).toBe(`file://${WORKSPACE}/nested/file.txt`)
    expect(fs.contains(root, root)).toBe(true)
    expect(fs.contains(root, child)).toBe(true)
    expect(fs.contains(root, outside)).toBe(false)
  })

  it('preserves POSIX filename bytes in a file URL', async () => {
    seedFile(`${WORKSPACE}/file #?.txt`, 'x')
    const target = await fs.resolve('file #?.txt')
    expect(fs.fileUrl(target)).toBe('file:///workspace/e2b/file%20%23%3F.txt')
  })

  it('compares canonical identities without accepting a sibling prefix', async () => {
    seedFile(`${WORKSPACE}/a.txt`, 'a')
    seedFile('/workspace/e2b-other/file', 'other')
    seedFile('/outside/file', 'outside')
    const root = await fs.resolve('.')
    const child = await fs.resolve('a.txt')
    const sibling = await fs.resolve('/workspace/e2b-other/file')
    const parent = await fs.resolve('..')
    const outside = await fs.resolve('/outside/file')
    expect(fs.contains(root, child)).toBe(true)
    expect(fs.contains(root, sibling)).toBe(false)
    expect(fs.contains(root, parent)).toBe(false)
    expect(fs.contains(root, outside)).toBe(false)
  })

  it('declares watching unsupported without contacting the sandbox', async () => {
    seedDir(WORKSPACE)
    const target = await fs.resolve('.')
    expect(fixture.getInfoCalls).toHaveLength(1)
    await expect(fs.watch(target, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(fixture.getInfoCalls).toHaveLength(1)
  })

  it('reports no default sandbox mode and no host path mapping', () => {
    expect(fs.sandboxMode).toBeUndefined()
    expect(fs.processPathFromHostPath('/host/private/file.ts')).toBeUndefined()
  })
})

describe('stat and lstat', () => {
  it('stats files, directories, and absent paths', async () => {
    seedFile(`${WORKSPACE}/a.txt`, 'hello')
    seedDir(`${WORKSPACE}/sub`)
    const file = await fs.resolve('a.txt')
    const dir = await fs.resolve('sub')
    const absent = await fs.resolve('ghost.txt')
    expect(await fs.stat(file)).toMatchObject({ type: 'file', size: 5 })
    expect(await fs.stat(dir)).toMatchObject({ type: 'directory' })
    expect(await fs.stat(absent)).toBeUndefined()
  })

  it('follows symbolic links for stat and reports the link itself for lstat', async () => {
    seedFile(`${WORKSPACE}/target.txt`, 'target')
    seedSymlink(`${WORKSPACE}/link`, 'target.txt')
    seedDir(`${WORKSPACE}/dir`)
    const viaLink = await fs.resolve('link')
    expect(fs.processPath(viaLink)).toBe(`${WORKSPACE}/target.txt`)
    expect(await fs.stat(viaLink)).toMatchObject({ type: 'file', size: 6 })
    expect(await fs.lstat('link')).toMatchObject({ type: 'symlink' })
    expect(await fs.lstat('target.txt')).toMatchObject({ type: 'file' })
    expect(await fs.lstat('dir')).toMatchObject({ type: 'directory' })
    expect(await fs.lstat('ghost.txt')).toBeUndefined()
  })

  it('reports an untyped entry as other with a zero modification fallback', async () => {
    seedOpaque(`${WORKSPACE}/opaque.bin`)
    const target = await fs.resolve('opaque.bin')
    const info = await fs.stat(target)
    expect(info).toMatchObject({ type: 'other', size: 0 })
    expect(typeof info?.version).toBe('string')
    expect(await fs.lstat('opaque.bin')).toMatchObject({ type: 'other' })
  })

  it('translates a sandbox metadata failure into FS_IO_ERROR', async () => {
    const target = await fs.resolve('.')
    fixture.getInfoFailure = new Error('metadata backend down')
    await expect(fs.stat(target)).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot stat "${WORKSPACE}": metadata backend down`,
    })
  })

  it('translates a non-Error rejection into FS_IO_ERROR', async () => {
    const target = await fs.resolve('.')
    fixture.getInfoFailure = 'metadata said no'
    await expect(fs.stat(target)).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot stat "${WORKSPACE}": metadata said no`,
    })
  })
})

describe('reads', () => {
  it('reads whole text byte-for-byte and forwards the signal', async () => {
    seedFile(`${WORKSPACE}/crlf.txt`, 'a\r\nb\r\n')
    const target = await fs.resolve('crlf.txt')
    const signal = new AbortController().signal
    expect(await fs.readText(target, signal)).toBe('a\r\nb\r\n')
    expect(fixture.readCalls[0]?.opts?.signal).toBe(signal)
  })

  it('rejects missing, non-regular, binary, and invalid UTF-8 targets', async () => {
    seedDir(`${WORKSPACE}/sub`)
    seedFile(`${WORKSPACE}/binary.bin`, new Uint8Array([0x41, 0x00, 0x42]))
    seedFile(`${WORKSPACE}/invalid.txt`, new Uint8Array([0xff, 0x41]))
    await expect(fs.readText(await fs.resolve('ghost.txt')))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND', message: `cannot read "${WORKSPACE}/ghost.txt": not found` })
    await expect(fs.readText(await fs.resolve('sub')))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await expect(fs.readText(await fs.resolve('binary.bin')))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT', message: `cannot read "${WORKSPACE}/binary.bin": binary file` })
    await expect(fs.readText(await fs.resolve('invalid.txt')))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('reads whole bytes within the limit and rejects oversized content', async () => {
    seedFile(`${WORKSPACE}/hello.txt`, 'hello')
    const target = await fs.resolve('hello.txt')
    expect(new TextDecoder().decode(await fs.readBytes(target, undefined, 10))).toBe('hello')
    await expect(fs.readBytes(target, undefined, 3)).rejects.toMatchObject({
      code: 'FS_TOO_LARGE',
      message: `cannot read "${WORKSPACE}/hello.txt": 5 bytes exceeds the 3-byte limit`,
    })
    seedFile(`${WORKSPACE}/grew.txt`, 'tiny', {
      chunks: [new TextEncoder().encode('tiny grew past the cap')],
    })
    const grew = await fs.resolve('grew.txt')
    await expect(fs.readBytes(grew, undefined, 10)).rejects.toMatchObject({
      code: 'FS_TOO_LARGE',
      message: `cannot read "${WORKSPACE}/grew.txt": content exceeds the 10-byte limit`,
    })
    const absent = await fs.resolve('ghost.txt')
    await expect(fs.readBytes(absent, undefined, 10)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('reads byte ranges across stream chunk boundaries', async () => {
    seedFile(`${WORKSPACE}/range.txt`, '0123456789', {
      chunks: ['0123', '4567', '89'].map(part => new TextEncoder().encode(part)),
    })
    const target = await fs.resolve('range.txt')
    const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
    expect(decode(await fs.readByteRange(target, { offset: 2, length: 5 }))).toBe('23456')
    expect(decode(await fs.readByteRange(target, { offset: 6, length: 4 }))).toBe('6789')
    expect(decode(await fs.readByteRange(target, { offset: 20, length: 5 }))).toBe('')
    expect(decode(await fs.readByteRange(target, { offset: 0, length: 0 }))).toBe('')
  })

  it('streams decoded text chunks to completion and forwards the signal', async () => {
    seedFile(`${WORKSPACE}/stream.txt`, 'chunk-one chunk-two')
    const target = await fs.resolve('stream.txt')
    const signal = new AbortController().signal
    expect(await collect(await fs.streamText(target, signal))).toBe('chunk-one chunk-two')
    expect(fixture.readCalls[0]?.opts?.signal).toBe(signal)
    expect(fixture.streamCancels).toBe(0)
  })

  it('carries multibyte characters across chunk boundaries', async () => {
    seedFile(`${WORKSPACE}/utf8.txt`, 'héllo', {
      chunks: [new Uint8Array([0x68, 0xc3]), new Uint8Array([0xa9, 0x6c, 0x6c, 0x6f])],
    })
    const target = await fs.resolve('utf8.txt')
    expect(await collect(await fs.streamText(target))).toBe('héllo')
  })

  it('screens only the leading bytes of a long stream for binary content', async () => {
    const head = 'a'.repeat(BINARY_SAMPLE_BYTES)
    seedFile(`${WORKSPACE}/big.txt`, `${head} tail`, {
      chunks: [new TextEncoder().encode(head), new TextEncoder().encode(' tail')],
    })
    const target = await fs.resolve('big.txt')
    expect(await collect(await fs.streamText(target))).toBe(`${head} tail`)
  })

  it('skips empty stream chunks', async () => {
    seedFile(`${WORKSPACE}/gaps.txt`, 'abcd', {
      chunks: [
        new TextEncoder().encode('ab'),
        new Uint8Array(0),
        new TextEncoder().encode('cd'),
      ],
    })
    const target = await fs.resolve('gaps.txt')
    expect(await collect(await fs.streamText(target))).toBe('abcd')
  })

  it('rejects binary content beyond the first chunk', async () => {
    seedFile(`${WORKSPACE}/latebin.bin`, new Uint8Array(101), {
      chunks: [new Uint8Array(100).fill(0x61), new Uint8Array([0x00])],
    })
    const target = await fs.resolve('latebin.bin')
    await expect(collect(await fs.streamText(target)))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('rejects invalid UTF-8 in the stream', async () => {
    seedFile(`${WORKSPACE}/badutf.txt`, new Uint8Array([0xff]), { chunks: [new Uint8Array([0xff])] })
    const target = await fs.resolve('badutf.txt')
    await expect(collect(await fs.streamText(target)))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('cancels the source when the consumer stops early', async () => {
    seedFile(`${WORKSPACE}/stop.txt`, 'abcdef', {
      chunks: [new TextEncoder().encode('abc'), new TextEncoder().encode('def')],
    })
    const target = await fs.resolve('stop.txt')
    for await (const chunk of await fs.streamText(target)) {
      expect(chunk).toBe('abc')
      break
    }
    expect(fixture.streamCancels).toBe(1)
  })

  it('rejects with FS_ABORTED when the signal aborts mid-stream', async () => {
    seedFile(`${WORKSPACE}/abort.txt`, 'abcdefghij', {
      chunks: ['abcd', 'efgh', 'ij'].map(part => new TextEncoder().encode(part)),
    })
    const controller = new AbortController()
    let pulls = 0
    fixture.streamPull = () => {
      if (++pulls === 2) controller.abort()
    }
    const target = await fs.resolve('abort.txt')
    const stream = await fs.streamText(target, controller.signal)
    await expect(collect(stream)).rejects.toMatchObject({ code: 'FS_ABORTED', message: 'read aborted' })
    expect(fixture.streamCancels).toBe(1)
  })

  it('translates a mid-stream failure into FS_IO_ERROR', async () => {
    seedFile(`${WORKSPACE}/fail.txt`, 'abcdefghij', {
      chunks: ['abcd', 'efgh'].map(part => new TextEncoder().encode(part)),
    })
    let pulls = 0
    fixture.streamPull = () => {
      if (++pulls === 2) throw new Error('stream broke')
    }
    const target = await fs.resolve('fail.txt')
    await expect(collect(await fs.streamText(target))).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot read "${WORKSPACE}/fail.txt": stream broke`,
    })
  })

  it('surfaces a stream-open failure as FS_IO_ERROR', async () => {
    seedFile(`${WORKSPACE}/open.txt`, 'content')
    fixture.readFailure = new Error('open failed')
    const target = await fs.resolve('open.txt')
    await expect(collect(await fs.streamText(target))).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot read "${WORKSPACE}/open.txt": open failed`,
    })
  })
})

describe('listDir', () => {
  it('lists children in stable order with resolved targets and cheap metadata', async () => {
    seedFile(`${WORKSPACE}/d/zeta.txt`, 'z')
    seedFile(`${WORKSPACE}/d/alpha.txt`, 'alpha')
    seedFile(`${WORKSPACE}/d/target.txt`, 'target')
    seedDir(`${WORKSPACE}/d/sub`)
    seedSymlink(`${WORKSPACE}/d/link`, 'target.txt')
    const dir = await fs.resolve('d')
    const entries = await fs.listDir(dir)
    expect(entries.map(entry => entry.name)).toEqual(['alpha.txt', 'link', 'sub', 'target.txt', 'zeta.txt'])
    const alpha = entries.find(entry => entry.name === 'alpha.txt')
    expect(alpha).toMatchObject({ type: 'file', size: 5 })
    expect(typeof alpha?.version).toBe('string')
    const sub = entries.find(entry => entry.name === 'sub')
    expect(sub).toMatchObject({ type: 'directory' })
    expect(sub?.size).toBeUndefined()
    const link = requireEntry(entries, 'link')
    expect(link).toMatchObject({ type: 'file', size: 6 })
    expect(fs.processPath(link.target)).toBe(`${WORKSPACE}/d/target.txt`)
    expect(await fs.readText(link.target)).toBe('target')
  })

  it('reports an entry that vanished after the listing as other without a version', async () => {
    seedFile(`${WORKSPACE}/d/keep.txt`, 'keep')
    seedFile(`${WORKSPACE}/d/gone.txt`, 'gone')
    fixture.afterList = () => fixture.files.delete(`${WORKSPACE}/d/gone.txt`)
    const dir = await fs.resolve('d')
    const entries = await fs.listDir(dir)
    const gone = requireEntry(entries, 'gone.txt')
    expect(gone).toMatchObject({ type: 'other' })
    expect(gone.version).toBeUndefined()
    expect(fs.processPath(gone.target)).toBe(`${WORKSPACE}/d/gone.txt`)
  })

  it('rejects a missing directory and a non-directory', async () => {
    seedFile(`${WORKSPACE}/a.txt`, 'a')
    const absent = await fs.resolve('ghost')
    await expect(fs.listDir(absent)).rejects.toMatchObject({
      code: 'FS_NOT_FOUND',
      message: `cannot list "${WORKSPACE}/ghost": not found`,
    })
    const file = await fs.resolve('a.txt')
    await expect(fs.listDir(file)).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
  })

  it('translates a listing failure into FS_IO_ERROR', async () => {
    seedDir(`${WORKSPACE}/d`)
    fixture.listFailure = new Error('listing backend down')
    const dir = await fs.resolve('d')
    await expect(fs.listDir(dir)).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot list "${WORKSPACE}/d": listing backend down`,
    })
  })
})

describe('writeText', () => {
  it('creates a file with missing parent directories and forwards the signal', async () => {
    const target = await fs.resolve('deep/new.txt')
    const signal = new AbortController().signal
    const outcome = await fs.writeText(target, 'hi', undefined, signal)
    expect(outcome).toMatchObject({ operation: 'create', before: null, after: 'hi' })
    expect(await fs.readText(target)).toBe('hi')
    expect(fixture.writeCalls[0]?.opts?.signal).toBe(signal)
  })

  it('overwrites with an LF-normalized diff basis and a fresh version', async () => {
    seedFile(`${WORKSPACE}/note.txt`, 'old\r\nline')
    const target = await fs.resolve('note.txt')
    const before = await versionOf(target)
    const outcome = await fs.writeText(target, 'new')
    expect(outcome).toMatchObject({ operation: 'update', before: 'old\nline', after: 'new' })
    expect(outcome.version).not.toBe(before)
    expect(await fs.readText(target)).toBe('new')
  })

  it('stores CRLF content while reporting an LF diff basis', async () => {
    const target = await fs.resolve('crlf.txt')
    const outcome = await fs.writeText(target, 'a\r\nb')
    expect(outcome.after).toBe('a\nb')
    expect(new TextDecoder().decode(rawContent(`${WORKSPACE}/crlf.txt`))).toBe('a\r\nb')
  })

  it('createIfAbsent creates and refuses to blind-overwrite', async () => {
    const target = await fs.resolve('fresh.txt')
    await fs.writeText(target, 'first', { kind: 'createIfAbsent' })
    await expect(fs.writeText(target, 'second', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({
        code: 'FS_NOT_OBSERVED',
        message: `cannot overwrite existing "${WORKSPACE}/fresh.txt" without reading it first`,
      })
    expect(await fs.readText(target)).toBe('first')
  })

  it('replaceIfVersion replaces on match and rejects stale or missing files', async () => {
    seedFile(`${WORKSPACE}/guard.txt`, 'v1')
    const target = await fs.resolve('guard.txt')
    const observed = await versionOf(target)
    const outcome = await fs.writeText(target, 'v2', { kind: 'replaceIfVersion', version: observed })
    expect(outcome.operation).toBe('update')
    await expect(fs.writeText(target, 'v3', { kind: 'replaceIfVersion', version: observed }))
      .rejects.toMatchObject({
        code: 'FS_STALE_VERSION',
        message: `cannot write "${WORKSPACE}/guard.txt": file changed since it was read`,
      })
    const absent = await fs.resolve('ghost.txt')
    await expect(fs.writeText(absent, 'v1', { kind: 'replaceIfVersion', version: observed }))
      .rejects.toMatchObject({
        code: 'FS_STALE_VERSION',
        message: `cannot write "${WORKSPACE}/ghost.txt": file no longer exists`,
      })
  })

  it('refuses to write over a directory', async () => {
    seedDir(`${WORKSPACE}/dir`)
    const target = await fs.resolve('dir')
    await expect(fs.writeText(target, 'x')).rejects.toMatchObject({
      code: 'FS_NOT_REGULAR_FILE',
      message: `cannot write "${WORKSPACE}/dir": not a regular file`,
    })
  })

  it('bounds and repairs the contextual diff basis', async () => {
    await remount({ diffBasisMaxBytes: 16 })
    seedFile(`${WORKSPACE}/small.txt`, 'ok')
    const small = await fs.resolve('small.txt')
    const tooBigForBasis = await fs.writeText(small, 'x'.repeat(20))
    expect(tooBigForBasis.before).toBeNull()

    seedFile(`${WORKSPACE}/prior.txt`, 'y'.repeat(20))
    const prior = await fs.resolve('prior.txt')
    expect((await fs.writeText(prior, 'v')).before).toBeNull()

    seedFile(`${WORKSPACE}/grow.txt`, 'five')
    fixture.readOverride = () => new Uint8Array(16)
    const grew = await fs.resolve('grow.txt')
    expect((await fs.writeText(grew, 'v')).before).toBeNull()
    delete fixture.readOverride
  })

  it('falls back to no basis for binary, invalid, missing, or unreadable prior content', async () => {
    await remount({ diffBasisMaxBytes: 16 })
    seedFile(`${WORKSPACE}/bin.dat`, new Uint8Array([0x41, 0x00]))
    const bin = await fs.resolve('bin.dat')
    expect((await fs.writeText(bin, 'v')).before).toBeNull()

    seedFile(`${WORKSPACE}/bad.txt`, new Uint8Array([0xff]))
    const bad = await fs.resolve('bad.txt')
    expect((await fs.writeText(bad, 'v')).before).toBeNull()

    seedFile(`${WORKSPACE}/gone.txt`, 'present')
    const gone = await fs.resolve('gone.txt')
    fixture.readFailure = new FileNotFoundError('raced away')
    expect((await fs.writeText(gone, 'v')).before).toBeNull()

    seedFile(`${WORKSPACE}/broken.txt`, 'readable')
    const broken = await fs.resolve('broken.txt')
    fixture.readFailure = new Error('read backend down')
    expect((await fs.writeText(broken, 'v')).before).toBeNull()
  })

  it('propagates cancellation raised while reading the diff basis', async () => {
    seedFile(`${WORKSPACE}/cancel.txt`, 'text')
    const target = await fs.resolve('cancel.txt')
    fixture.readFailure = Object.assign(new Error('caller stopped'), { name: 'AbortError' })
    await expect(fs.writeText(target, 'v')).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(fixture.writeCalls).toHaveLength(0)
    delete fixture.readFailure
    expect(await fs.readText(target)).toBe('text')
  })

  it('falls back to a sentinel version when the file vanishes after the write', async () => {
    fixture.dropAfterWrite.add(`${WORKSPACE}/dropped.txt`)
    const target = await fs.resolve('dropped.txt')
    const outcome = await fs.writeText(target, 'written')
    expect(outcome.version.startsWith('missing:')).toBe(true)
    expect(rawContent(`${WORKSPACE}/dropped.txt`)).toBeUndefined()
  })

  it('stops before the write request when the caller aborts during the diff basis', async () => {
    seedFile(`${WORKSPACE}/midflight.txt`, 'prior')
    const target = await fs.resolve('midflight.txt')
    const controller = new AbortController()
    fixture.readOverride = () => {
      controller.abort()
      return new TextEncoder().encode('prior')
    }
    await expect(fs.writeText(target, 'v', undefined, controller.signal))
      .rejects.toMatchObject({ code: 'FS_ABORTED', message: 'write aborted' })
    expect(fixture.writeCalls).toHaveLength(0)
  })

  it('translates a sandbox write failure into FS_IO_ERROR', async () => {
    const target = await fs.resolve('quota.txt')
    fixture.writeFailure = new Error('quota exceeded')
    await expect(fs.writeText(target, 'v')).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot write "${WORKSPACE}/quota.txt": quota exceeded`,
    })
  })

  it('serializes concurrent writes to one target in arrival order', async () => {
    const target = await fs.resolve('race.txt')
    await Promise.all([fs.writeText(target, 'one'), fs.writeText(target, 'two')])
    expect(await fs.readText(target)).toBe('two')
  })

  it('serializes guarded concurrent writes so the second observes staleness', async () => {
    seedFile(`${WORKSPACE}/guarded.txt`, 'v0')
    const target = await fs.resolve('guarded.txt')
    const observed = await versionOf(target)
    const settled = await Promise.allSettled([
      fs.writeText(target, 'v1', { kind: 'replaceIfVersion', version: observed }),
      fs.writeText(target, 'v2', { kind: 'replaceIfVersion', version: observed }),
    ])
    expect(settled[0].status).toBe('fulfilled')
    if (settled[1].status !== 'rejected') throw new Error('expected the second guarded write to reject')
    expect(settled[1].reason).toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await fs.readText(target)).toBe('v1')
  })
})

describe('editText', () => {
  it('applies a literal edit at the matching version', async () => {
    seedFile(`${WORKSPACE}/edit.txt`, 'hello world')
    const target = await fs.resolve('edit.txt')
    const version = await versionOf(target)
    const outcome = await fs.editText(
      target,
      { oldString: 'world', newString: 'there', replaceAll: false },
      { version },
    )
    expect(outcome).toMatchObject({ before: 'hello world', after: 'hello there' })
    expect(outcome.version).not.toBe(version)
    expect(await fs.readText(target)).toBe('hello there')
  })

  it('restores CRLF storage after an LF-normalized edit', async () => {
    seedFile(`${WORKSPACE}/crlf.txt`, 'a\r\nb\r\n')
    const target = await fs.resolve('crlf.txt')
    const version = await versionOf(target)
    const outcome = await fs.editText(
      target,
      { oldString: 'a\nb', newString: 'x\ny', replaceAll: false },
      { version },
    )
    expect(outcome).toMatchObject({ before: 'a\nb\n', after: 'x\ny\n' })
    expect(new TextDecoder().decode(rawContent(`${WORKSPACE}/crlf.txt`))).toBe('x\r\ny\r\n')
    expect(await fs.readText(target)).toBe('x\r\ny\r\n')
  })

  it('replaces every match when replaceAll is set', async () => {
    seedFile(`${WORKSPACE}/multi.txt`, 'a-a-a')
    const target = await fs.resolve('multi.txt')
    const outcome = await fs.editText(
      target,
      { oldString: 'a', newString: 'b', replaceAll: true },
      undefined,
    )
    expect(outcome.after).toBe('b-b-b')
  })

  it('rejects a stale version before matching', async () => {
    seedFile(`${WORKSPACE}/stale.txt`, 'hello world')
    const target = await fs.resolve('stale.txt')
    const stale = await versionOf(target)
    await fs.editText(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, { version: stale })
    await expect(fs.editText(target, { oldString: 'world', newString: 'there', replaceAll: false }, { version: stale }))
      .rejects.toMatchObject({
        code: 'FS_STALE_VERSION',
        message: `cannot edit "${WORKSPACE}/stale.txt": file changed since it was read`,
      })
  })

  it('rejects missing targets, directories, and unmatched or ambiguous matches', async () => {
    seedDir(`${WORKSPACE}/dir`)
    seedFile(`${WORKSPACE}/ambig.txt`, 'x x x')
    const absent = await fs.resolve('ghost.txt')
    await expect(fs.editText(absent, { oldString: 'x', newString: 'y', replaceAll: false }))
      .rejects.toMatchObject({
        code: 'FS_STALE_VERSION',
        message: `cannot edit "${WORKSPACE}/ghost.txt": file changed since it was read`,
      })
    const dir = await fs.resolve('dir')
    await expect(fs.editText(dir, { oldString: 'x', newString: 'y', replaceAll: false }))
      .rejects.toMatchObject({
        code: 'FS_NOT_REGULAR_FILE',
        message: `cannot edit "${WORKSPACE}/dir": not a regular file`,
      })
    const ambig = await fs.resolve('ambig.txt')
    await expect(fs.editText(ambig, { oldString: 'x', newString: 'y', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    await expect(fs.editText(ambig, { oldString: 'zz', newString: 'y', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
  })

  it('translates a sandbox read failure during edit into FS_IO_ERROR', async () => {
    seedFile(`${WORKSPACE}/edit.txt`, 'content')
    const target = await fs.resolve('edit.txt')
    fixture.readFailure = new Error('read backend down')
    await expect(fs.editText(target, { oldString: 'content', newString: 'other', replaceAll: false }))
      .rejects.toMatchObject({
        code: 'FS_IO_ERROR',
        message: `cannot edit "${WORKSPACE}/edit.txt": read backend down`,
      })
  })
})

describe('signals', () => {
  it.each<[string, (filesystem: E2bFileSystem, target: FsTarget) => Promise<unknown>]>([
    ['resolve', filesystem => filesystem.resolve('a.txt', { signal: AbortSignal.abort() })],
    ['stat', (filesystem, target) => filesystem.stat(target, AbortSignal.abort())],
    ['lstat', filesystem => filesystem.lstat('a.txt', {}, AbortSignal.abort())],
    ['readText', (filesystem, target) => filesystem.readText(target, AbortSignal.abort())],
    ['streamText', (filesystem, target) => filesystem.streamText(target, AbortSignal.abort())],
    ['readBytes', (filesystem, target) => filesystem.readBytes(target, AbortSignal.abort(), 10)],
    ['readByteRange', (filesystem, target) => filesystem.readByteRange(target, { offset: 0, length: 1 }, AbortSignal.abort())],
    ['listDir', (filesystem, target) => filesystem.listDir(target, AbortSignal.abort())],
    ['writeText', (filesystem, target) => filesystem.writeText(target, 'x', undefined, AbortSignal.abort())],
    ['editText', (filesystem, target) => filesystem.editText(
      target,
      { oldString: 'abc', newString: 'x', replaceAll: false },
      undefined,
      AbortSignal.abort(),
    )],
  ])('%s rejects a pre-aborted signal with FS_ABORTED', async (name, run) => {
    seedFile(`${WORKSPACE}/a.txt`, 'abc')
    seedDir(`${WORKSPACE}/dir`)
    const target = await fs.resolve(name === 'listDir' ? 'dir' : 'a.txt')
    await expect(run(fs, target)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})
