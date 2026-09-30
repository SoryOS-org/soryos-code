/**
 * Tests for the shared overwrite-diff basis limits: the default side size,
 * the runtime cap, and the constructor validation every backend applies.
 */

import { constants as bufferConstants } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DIFF_BASIS_MAX_BYTES, MAX_DIFF_BASIS_BYTES, assertDiffBasisMaxBytes } from '@deepseek-ai/dsh-fs'

describe('diff-basis limits', () => {
  it('defaults each overwrite-diff side to 10 MiB', () => {
    expect(DEFAULT_DIFF_BASIS_MAX_BYTES).toBe(10 * 1024 * 1024)
  })

  it('caps the limit at the runtime allocation and decode maximum', () => {
    expect(MAX_DIFF_BASIS_BYTES).toBe(Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH))
  })

  it('accepts every positive safe integer up to the cap', () => {
    expect(() => { assertDiffBasisMaxBytes(1, 'fs-test') }).not.toThrow()
    expect(() => { assertDiffBasisMaxBytes(DEFAULT_DIFF_BASIS_MAX_BYTES, 'fs-test') }).not.toThrow()
    expect(() => { assertDiffBasisMaxBytes(MAX_DIFF_BASIS_BYTES, 'fs-test') }).not.toThrow()
  })

  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['a limit above the runtime cap', MAX_DIFF_BASIS_BYTES + 1],
  ] as const)('rejects %s with the owner-named message', (_label, value) => {
    expect(() => { assertDiffBasisMaxBytes(value, 'fs-test') })
      .toThrow(`fs-test: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`)
  })
})
