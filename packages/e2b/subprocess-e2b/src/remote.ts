/**
 * Shared remote-control helpers for the E2B subprocess adapter: shell-layer
 * shaping for SDK calls, poll ticks, and the one tolerant process-group signal
 * used by both the ordinary-process and terminal teardown ladders.
 */

import { randomUUID } from 'node:crypto'
import { CommandExitError, SandboxNotFoundError } from 'e2b'
import type { E2bSandboxOperations } from './types.ts'

/**
 * Quote one opaque argument for the SDK's unavoidable `/bin/bash -l -c` layer.
 * @param value - Exact argument value to preserve.
 * @returns A single shell word with no interpolation.
 */
export function quoteE2BShellArg(value: string): string {
  return `'${value.replaceAll('\'', "'\"'\"'")}'`
}

/**
 * Isolate E2B's hard-coded login shell behind a fresh randomized home path.
 * @param overrides - Additional environment entries for the internal command.
 * @returns A fresh mutable map that the E2B SDK may extend.
 */
export function e2bControlEnvs(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...overrides, HOME: `/.dsh-e2b-control-${randomUUID()}` }
}

/**
 * Normalize an unknown rejection into an Error.
 * @param error - Any thrown or rejected value.
 * @returns The value itself when already an Error, else a stringified wrapper.
 */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Shape the optional-signal SDK options object.
 * @param signal - Optional cancellation for one SDK request.
 * @returns An options fragment that omits an undefined signal.
 */
export function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

/**
 * Shape control-shell command options with the isolated HOME override.
 * @param envs - Explicit environment entries for the control command.
 * @param signal - Optional cancellation for the SDK request.
 * @returns Options for `sandbox.commands.run` control invocations.
 */
export function commandOpts(
  envs: Record<string, string>,
  signal?: AbortSignal,
): { envs: Record<string, string>; signal?: AbortSignal } {
  return { envs: e2bControlEnvs(envs), ...signalOpts(signal) }
}

/**
 * Resolve after one duration.
 * @param ms - Milliseconds to wait.
 * @returns Settles after the timeout.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Wait one poll interval or until the signal aborts.
 * @param pollMs - Poll cadence in milliseconds.
 * @param signal - Optional abort that ends the wait early.
 * @returns `true` after a full tick, `false` when aborted first.
 */
export function waitTick(pollMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, pollMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Signal remote process groups, tolerating the shared teardown outcomes: a
 * nonzero `kill` (groups already gone) and a disappeared sandbox. Both the
 * pgid-keyed process ladder and the sid-keyed terminal ladder deliver signals
 * through this single tolerance so they cannot drift apart.
 * @param sandbox - Live remote operations handle.
 * @param envs - Control-shell environment entries.
 * @param groups - Positive process-group ids to signal.
 * @param signal - `TERM` or `KILL`.
 */
export async function signalRemoteGroups(
  sandbox: E2bSandboxOperations,
  envs: Record<string, string>,
  groups: readonly number[],
  signal: 'TERM' | 'KILL',
): Promise<void> {
  // TODO(e2b-pgid-identity): Prefer an atomic identity-bound group signal if E2B adds one;
  // a userspace identity precheck cannot close the numeric-PGID reuse race.
  try {
    await sandbox.commands.run(
      `kill -${signal} -- ${groups.map(group => `-${group}`).join(' ')}`,
      commandOpts(envs),
    )
  } catch (error: unknown) {
    if (!(error instanceof CommandExitError) && !(error instanceof SandboxNotFoundError)) throw error
  }
}
