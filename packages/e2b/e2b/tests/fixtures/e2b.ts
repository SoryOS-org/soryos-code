/** External E2B SDK fixture; the connection's own state machine under test stays real. */

import type { ConnectionOpts, SandboxConnectOpts, SandboxOpts } from 'e2b'

/** Control-plane fields accepted by a workspace filesystem request. */
type FilesystemOpts = { requestTimeoutMs?: number; signal?: AbortSignal }

/** Recorded SDK calls, controllable failures, and the fake ID counter. */
export const fixture: {
  /** Instances returned by create and static connect. */
  sandboxes: Sandbox[]
  /** Template name argument of each create call, in order. */
  createTemplates: Array<string | undefined>
  /** Options of each create call, in order. */
  createOptions: Array<SandboxOpts | undefined>
  /** Sandbox IDs passed to static connect, in order. */
  connectIds: string[]
  /** Options of each static connect call, in order. */
  connectOptions: Array<SandboxConnectOpts | undefined>
  /** Options of each instance connect (resume) call, in order. */
  resumeOptions: Array<SandboxConnectOpts | undefined>
  /** Options of each pause call, in order. */
  pauseOptions: Array<ConnectionOpts | undefined>
  /** Options of each kill call, in order. */
  killOptions: Array<ConnectionOpts | undefined>
  /** Path and options of each workspace makeDir call, in order. */
  makeDirs: Array<{ path: string; opts: FilesystemOpts | undefined }>
  /** Rejection raised by static connect while set. */
  connectError?: unknown
  /** Rejection raised by pause while set. */
  pauseError?: unknown
  /** Rejection raised by instance connect (resume) while set. */
  resumeError?: unknown
  /** Rejection raised by kill while set. */
  killError?: unknown
  /** Rejection raised by workspace makeDir while set. */
  makeDirError?: unknown
  /** Next fake sandbox ID suffix. */
  nextId: number
} = {
  sandboxes: [],
  createTemplates: [],
  createOptions: [],
  connectIds: [],
  connectOptions: [],
  resumeOptions: [],
  pauseOptions: [],
  killOptions: [],
  makeDirs: [],
  nextId: 1,
}

/** Restore recorded calls and clear every failure hook after a test. */
export function resetFixture(): void {
  fixture.sandboxes = []
  fixture.createTemplates = []
  fixture.createOptions = []
  fixture.connectIds = []
  fixture.connectOptions = []
  fixture.resumeOptions = []
  fixture.pauseOptions = []
  fixture.killOptions = []
  fixture.makeDirs = []
  fixture.nextId = 1
  delete fixture.connectError
  delete fixture.pauseError
  delete fixture.resumeError
  delete fixture.killError
  delete fixture.makeDirError
}

/** Fake sandbox exposing only the operations the connection drives. */
export class Sandbox {
  /**
   * Record one create call and hand back a new fake sandbox.
   * @param templateOrOpts - template name when given, otherwise create options.
   * @param opts - create options paired with a template name.
   * @returns the fake sandbox for this create.
   */
  static async create(templateOrOpts?: string | SandboxOpts, opts?: SandboxOpts): Promise<Sandbox> {
    const template = typeof templateOrOpts === 'string' ? templateOrOpts : undefined
    fixture.createTemplates.push(template)
    fixture.createOptions.push(typeof templateOrOpts === 'string' ? opts : templateOrOpts)
    const sandbox = new Sandbox(`sbx-${fixture.nextId++}`)
    fixture.sandboxes.push(sandbox)
    return sandbox
  }

  /**
   * Record one static connect call and hand back the fake sandbox for the ID.
   * @param sandboxId - ID requested by the connection.
   * @param opts - connect options for this call.
   * @returns the fake sandbox for the requested ID.
   */
  static async connect(sandboxId: string, opts?: SandboxConnectOpts): Promise<Sandbox> {
    fixture.connectIds.push(sandboxId)
    fixture.connectOptions.push(opts)
    if (fixture.connectError !== undefined) throw fixture.connectError
    const sandbox = new Sandbox(sandboxId)
    fixture.sandboxes.push(sandbox)
    return sandbox
  }

  /** Workspace filesystem surface driven by initWorkspace. */
  readonly files: { makeDir: (path: string, opts?: FilesystemOpts) => Promise<boolean> }

  private constructor(readonly sandboxId: string) {
    this.files = {
      makeDir: async (path: string, opts?: FilesystemOpts): Promise<boolean> => {
        fixture.makeDirs.push({ path, opts })
        if (fixture.makeDirError !== undefined) throw fixture.makeDirError
        return true
      },
    }
  }

  /**
   * Record one pause call.
   * @param opts - control-plane options for this call.
   * @returns whether the fake sandbox paused.
   */
  async pause(opts?: ConnectionOpts): Promise<boolean> {
    fixture.pauseOptions.push(opts)
    if (fixture.pauseError !== undefined) throw fixture.pauseError
    return true
  }

  /**
   * Record one resume call.
   * @param opts - connect options for this call.
   * @returns the same fake sandbox once "resumed".
   */
  async connect(opts?: SandboxConnectOpts): Promise<Sandbox> {
    fixture.resumeOptions.push(opts)
    if (fixture.resumeError !== undefined) throw fixture.resumeError
    return this
  }

  /**
   * Record one kill call.
   * @param opts - control-plane options for this call.
   * @returns whether the fake sandbox killed.
   */
  async kill(opts?: ConnectionOpts): Promise<boolean> {
    fixture.killOptions.push(opts)
    if (fixture.killError !== undefined) throw fixture.killError
    return true
  }
}
