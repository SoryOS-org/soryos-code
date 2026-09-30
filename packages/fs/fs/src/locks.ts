/**
 * Per-target FIFO locking shared by filesystem providers: one mutating
 * operation at a time per target key, so a read→guard→write window on the
 * same target cannot interleave.
 * @module @deepseek-ai/dsh-fs/locks
 */

/**
 * Serializes mutating operations per target key. Waiters run in arrival
 * order, and an operation that fails releases the key without blocking its
 * successor.
 */
export class TargetLocks {
  /** Tail promise per target key; identity doubles as the ownership check on release. */
  private readonly tails = new Map<string, Promise<unknown>>()

  /**
   * Run `op` with exclusive access to `targetKey` (FIFO per key).
   * @param targetKey - stable identity of the target to lock.
   * @param op - mutating operation to run under the lock.
   * @returns the operation's result; its failure rethrows to this caller only.
   */
  async run<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(targetKey) ?? Promise.resolve()
    const run = prior.then(op, op)
    // Keep the chain alive but swallow this op's result/throw for the *next* waiter.
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.tails.get(targetKey) === tail) {
        this.tails.delete(targetKey)
      }
    }
  }
}
