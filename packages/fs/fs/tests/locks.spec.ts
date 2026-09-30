/**
 * Tests for the shared per-target lock table: arrival-order execution per
 * key, independent keys, failure isolation, and successor ownership of the
 * table entry so later arrivals queue behind a running operation.
 */

import { describe, expect, it } from 'vitest'
import { TargetLocks } from '@deepseek-ai/dsh-fs'

/** Settle after one macrotask so a wrongly unchained operation would have run. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('TargetLocks', () => {
  it('returns the operation result to its caller', async () => {
    const locks = new TargetLocks()
    await expect(locks.run('/a', async () => 'done')).resolves.toBe('done')
  })

  it('rethrows a failed operation and the next run on the key still executes', async () => {
    const locks = new TargetLocks()
    await expect(locks.run('/a', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(locks.run('/a', async () => 'recovered')).resolves.toBe('recovered')
  })

  it('runs same-key operations in arrival order', async () => {
    const locks = new TargetLocks()
    const order: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = locks.run('/k', async () => { await gate; order.push('first') })
    const second = locks.run('/k', async () => { order.push('second') })
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('runs different keys concurrently', async () => {
    const locks = new TargetLocks()
    let releaseA!: () => void
    const gate = new Promise<void>((resolve) => { releaseA = resolve })
    const a = locks.run('/a', async () => { await gate; return 'a' })
    await expect(locks.run('/b', async () => 'b')).resolves.toBe('b')
    releaseA()
    await expect(a).resolves.toBe('a')
  })

  it('keeps a completed predecessor from evicting its successor, so later arrivals queue behind it', async () => {
    const locks = new TargetLocks()
    const order: string[] = []
    let releaseA!: () => void
    let releaseB!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const gateB = new Promise<void>((resolve) => { releaseB = resolve })
    const a = locks.run('/k', async () => { await gateA; order.push('a') })
    const b = locks.run('/k', async () => { await gateB; order.push('b') })
    releaseA()
    await a
    const c = locks.run('/k', async () => { order.push('c') })
    await tick()
    expect(order).not.toContain('c')
    releaseB()
    await Promise.all([b, c])
    expect(order).toEqual(['a', 'b', 'c'])
  })
})
