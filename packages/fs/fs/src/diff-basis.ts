/**
 * Overwrite-diff basis bounds shared by filesystem providers: the default
 * per-side limit, the runtime allocation cap, and the constructor check that
 * validates a configured limit before any write reads a basis.
 * @module @deepseek-ai/dsh-fs/diff-basis
 */

import { constants as bufferConstants } from 'node:buffer'

/** Default exclusive UTF-8 byte limit on each overwrite-diff side (10 MiB). */
export const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/** Largest diff-basis limit a backend may accept: the runtime's safe allocation and decode maximum. */
export const MAX_DIFF_BASIS_BYTES = Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH)

/**
 * Validate a configured overwrite-diff basis limit at plugin construction.
 * @param value - configured limit to validate.
 * @param owner - backend name prefixed to the failure message.
 * @throws when `value` is not a positive safe integer no greater than
 *   {@link MAX_DIFF_BASIS_BYTES}.
 */
export function assertDiffBasisMaxBytes(value: number, owner: string): void {
  if (!Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_DIFF_BASIS_BYTES) {
    throw new Error(`${owner}: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`)
  }
}
