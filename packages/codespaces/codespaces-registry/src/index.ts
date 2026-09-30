/**
 * Durable per-workspace Codespaces environment state (`ctx.codespacesRegistry`):
 * the configuration a workspace was provisioned with, plus the provisioned
 * codespace identity, survive application restarts so a reconnect finds the
 * same codespace instead of creating a second one. One `codespaces` storage
 * domain, one table keyed by workspace id.
 * @module @deepseek-ai/dsh-codespaces-registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** The durable shape of one workspace's Codespaces environment state. */
export const codespacesWorkspaceState = z.object({
  /** Discriminant; only the codespaces environment is provisioned. */
  kind: z.literal('codespaces'),
  /** `owner/name` of the repository the codespace is created from. */
  repository: z.string().min(1),
  /** Git ref the codespace checks out. */
  branch: z.string().min(1).optional(),
  /** Machine type the codespace is created with. */
  machine: z.string().min(1).optional(),
  /** Devcontainer path inside the repository. */
  devcontainerPath: z.string().min(1).optional(),
  /** Idle timeout in minutes. */
  idleTimeoutMinutes: z.number().int().positive().optional(),
  /** Retention period in minutes. */
  retentionPeriodMinutes: z.number().int().min(0).max(43_200).optional(),
  /** Azure region. */
  location: z.string().min(1).optional(),
  /** User-facing display name. */
  displayName: z.string().min(1).optional(),
  /** The provisioned codespace name; set once creation succeeds. */
  codespaceName: z.string().min(1).optional(),
  /** The forwarded workspace URL once the runtime is reachable. */
  workspaceUrl: z.url().optional(),
}).strict()

/** One stored Codespaces workspace state, inferred from {@link codespacesWorkspaceState}. */
export type CodespacesWorkspaceState = z.infer<typeof codespacesWorkspaceState>

/** The domain spec: one `environments` table keyed by workspace id. */
export const codespacesDomainSpec = defineDomain({
  name: 'codespaces',
  version: 1,
  tables: { environments: domainTable<WorkspaceId, CodespacesWorkspaceState>(codespacesWorkspaceState) },
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    codespacesRegistry: CodespacesRegistry
  }
}

/** `ctx.codespacesRegistry`: the durable Codespaces environment state owner. */
export class CodespacesRegistry extends Service {
  static inject = ['storageDomain']

  constructor(ctx: Context) {
    super(ctx, 'codespacesRegistry')
  }

  /**
   * Read one workspace's stored Codespaces state.
   * @param workspaceId - the workspace the environment belongs to.
   * @returns the stored state, or undefined while the workspace has none.
   */
  async read(workspaceId: WorkspaceId): Promise<CodespacesWorkspaceState | undefined> {
    const domain = await this.ctx.storageDomain.open(codespacesDomainSpec)
    return domain.table('environments').get(workspaceId)
  }

  /**
   * Persist one workspace's Codespaces state. The whole record is replaced, so
   * a caller re-reads, edits, and writes the complete state.
   * @param workspaceId - the workspace the environment belongs to.
   * @param state - the complete state to store.
   */
  async save(workspaceId: WorkspaceId, state: CodespacesWorkspaceState): Promise<void> {
    const domain = await this.ctx.storageDomain.open(codespacesDomainSpec)
    await domain.table('environments').put(workspaceId, state)
  }

  /**
   * Remove one workspace's stored Codespaces state. The configuration fields
   * the caller wants to keep across a recreation are ordinary record edits,
   * not this operation's business.
   * @param workspaceId - the workspace whose state should be removed.
   */
  async remove(workspaceId: WorkspaceId): Promise<void> {
    const domain = await this.ctx.storageDomain.open(codespacesDomainSpec)
    await domain.table('environments').delete(workspaceId)
  }
}

export const name = 'codespaces-registry'

export const inject = ['storageDomain'] as const

/**
 * Mount the Codespaces registry service.
 * @param ctx - the host context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(CodespacesRegistry)
}

export default CodespacesRegistry
