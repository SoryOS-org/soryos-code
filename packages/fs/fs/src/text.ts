/**
 * Backend-shared text handling for filesystem providers: line-ending
 * normalization, literal-edit application, and UTF-8/binary rejection. Pure
 * in-memory functions with no I/O, so every `ctx.fs` backend applies the same
 * edit semantics and the same text/binary boundary.
 * @module @deepseek-ai/dsh-fs/text
 */

import { TextDecoder } from 'node:util'
import { FsError } from './types.ts'

/** Line ending style detected before LF normalization. */
export type LineEndings = 'LF' | 'CRLF'

/** Byte window scanned for NUL bytes before declaring content binary. */
export const BINARY_SAMPLE_BYTES = 8192

/**
 * Collapse CRLF to LF — the canonical in-memory form every edit/diff basis
 * uses. Lone `\r` bytes (not followed by `\n`) are left untouched.
 * @param content - decoded text in whatever line-ending style the file had.
 * @returns the text with every `\r\n` pair replaced by `\n`.
 */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/**
 * Detect the dominant line-ending style of raw file text from its first bytes.
 * @param raw - decoded file text as stored.
 * @returns `'CRLF'` when CRLF pairs outnumber lone LF breaks in the sample, otherwise `'LF'`.
 */
export function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * Convert LF-normalized content back to the line-ending style detected at read
 * time, for write-back. `LF` returns the content unchanged; `CRLF` re-normalizes
 * first so an already-CRLF sequence is never doubled to `\r\r\n`.
 * @param content - the LF-normalized (edited) text.
 * @param lineEndings - the original file's style, as detected by {@link detectLineEndings}.
 * @returns the text in the original file's line-ending style.
 */
export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Apply a literal replacement to LF-normalized content. Empty or missing search text throws
 * `FS_EDIT_NOT_FOUND`; multiple matches throw `FS_AMBIGUOUS_EDIT` unless `replaceAll` is true.
 * @param content - the current file content, already LF-normalized.
 * @param oldString - literal text to find; CRLF inside it is normalized to LF before
 *   matching.
 * @param newString - literal replacement text, normalized the same way.
 * @param replaceAll - replace every match instead of requiring exactly one.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the edited LF-normalized content plus how many occurrences were replaced.
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

function notTextError(verb: 'read' | 'edit', displayPath: string): FsError {
  return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

/**
 * Reject binary content by its NUL-byte sample before text decoding. The sample
 * is the first `sampleBytes` bytes of `buffer` (the whole buffer when omitted).
 * @param buffer - raw file content about to be treated as text.
 * @param verb - operation name used in the failure message.
 * @param displayPath - the caller-facing path used in error messages.
 * @param sampleBytes - leading byte window to scan; omit to scan the whole buffer.
 * @throws FsError with `FS_NOT_TEXT` when the sample contains a NUL byte.
 */
export function assertTextualBytes(buffer: Uint8Array, verb: 'read' | 'edit', displayPath: string, sampleBytes?: number): void {
  if (buffer.subarray(0, sampleBytes ?? buffer.length).includes(0)) {
    throw new FsError(`cannot ${verb} "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
}

/**
 * Decode complete file bytes as strict UTF-8.
 * @param buffer - raw file content with the NUL sample already rejected.
 * @param verb - operation name used in the failure message.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the decoded text, byte-for-byte (no line-ending normalization).
 * @throws FsError with `FS_NOT_TEXT` when the bytes are not valid UTF-8.
 */
export function decodeUtf8Text(buffer: Uint8Array, verb: 'read' | 'edit', displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

/**
 * Decode one chunk of a streaming UTF-8 read, carrying a partial multibyte
 * sequence into the next call.
 * @param decoder - the fatal UTF-8 decoder shared across the stream.
 * @param chunk - the next bytes, or undefined to flush the final sequence.
 * @param verb - operation name used in the failure message.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the text decoded from this step.
 * @throws FsError with `FS_NOT_TEXT` when the bytes are not valid UTF-8.
 */
export function decodeUtf8Chunk(decoder: TextDecoder, chunk: Uint8Array | undefined, verb: 'read' | 'edit', displayPath: string): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}
