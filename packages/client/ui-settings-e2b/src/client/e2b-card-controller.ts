/**
 * The E2B page's staged form over the `e2b` settings namespace.
 *
 * The key is the one control that does not live in the section: its literal
 * never rides a response, so the page learns only whether one is configured
 * and writes it through the credentials domain, addressed by the reference the
 * section names. It is still staged with the rest of the form, so one save
 * covers everything the page shows.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormShell, type SettingsFormScope, type SettingsFormScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the E2B connection. Spelled here rather than imported: a client
 * package must not depend on a Host package.
 */
export const E2B_NS = 'e2b'

/** Credential reference the connection resolves when the section names none. */
const DEFAULT_API_KEY_REF = 'E2B_API_KEY'

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/** The E2B connection fields this page edits. */
export interface E2bSettings {
  /** Credential reference naming the E2B API key. */
  apiKeyEnv?: string
  /** E2B control-plane domain; blank uses the SDK default. */
  domain?: string
  /** Sandbox template name or ID. */
  template?: string
  /** Sandbox lifetime in milliseconds. */
  timeoutMs?: number
  /** Control-plane request deadline in milliseconds. */
  requestTimeoutMs?: number
}

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials/set` can affect it; false disables the control. */
  writable: boolean
}

/** What the E2B page renders. */
export interface E2bCardState extends SettingsFormShell {
  /** Credential reference naming the key. */
  apiKeyEnv: SettingsFieldState
  /** Control-plane domain. */
  domain: SettingsFieldState
  /** Sandbox template. */
  template: SettingsFieldState
  /** Sandbox lifetime. */
  timeoutMs: SettingsFieldState
  /** Control-plane request deadline. */
  requestTimeoutMs: SettingsFieldState
  /** The staged credential, which starts blank on every load. */
  apiKey: SettingsFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
}

/** The registration-side face the E2B page's slot entry injects. */
export interface E2bCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useE2bCard. */
    e2bCard: SnapshotStore<E2bCardState>
  }
}

/** Bridges the `e2b` scope and the credentials domain onto the page. */
export class E2bCardController {
  private readonly form: SettingsFormModel<E2bSettings>
  private readonly store: SnapshotStore<E2bCardState>
  private readonly unsubscribe: () => void
  private credential: CredentialState = { ref: '', configured: false, writable: true }

  /**
   * @param scope - the bound settings scope for the `e2b` namespace.
   * @param ctx - the page plugin's context, whose `remote.credentials` namespace
   * answers for the credential the section references.
   */
  constructor(
    private readonly scope: SettingsFormScope<E2bSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.form = new SettingsFormModel(
      scope,
      [
        settingsTextField('apiKeyEnv'),
        settingsTextField('domain'),
        settingsTextField('template'),
        settingsNumberField('timeoutMs'),
        settingsNumberField('requestTimeoutMs'),
      ],
      [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }],
    )
    this.store = this.form.bind(() => this.projection())
    this.unsubscribe = scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  private projection(): E2bCardState {
    return {
      ...this.form.shell(),
      apiKeyEnv: this.form.field('apiKeyEnv'),
      domain: this.form.field('domain'),
      template: this.form.field('template'),
      timeoutMs: this.form.field('timeoutMs'),
      requestTimeoutMs: this.form.field('requestTimeoutMs'),
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    }
  }

  /**
   * Ask the credentials domain about the reference the section currently names.
   *
   * The answer is stored with the reference it describes: `apiKeyEnv` can
   * change between the request and its response, and two reads can settle out
   * of order, so a response is published only while it still answers for the
   * reference in force.
   */
  private async readCredential(): Promise<void> {
    const ref = refOf(this.scope.getSnapshot())
    if (ref !== this.credential.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok || ref !== refOf(this.scope.getSnapshot())) return
    const view = response.value[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      // An unknown reference is treated as writable: the control stays usable
      // and the Host is what refuses, rather than the page guessing a refusal.
      writable: view?.writable ?? true,
    }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
  }

  /**
   * Re-read after the Host reports a change to the reference this page watches.
   *
   * A key can be written from somewhere else, and the settings section does not
   * change when it is, so without this the badge keeps reporting a state the
   * Host already replaced.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): E2bCardFace {
    return { hooks: { e2bCard: this.store }, ...this.form.actions() }
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(value: string): Promise<boolean> {
    // Refusals surface through the re-read below: the Host is the only
    // authority on whether the key now exists.
    await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value)
    await this.readCredential()
    return this.credential.configured
  }

  /** Release configuration subscriptions. */
  dispose(): void { this.unsubscribe(); this.form.dispose() }
}

/**
 * The credential reference the section names, or the connection's default.
 * @param snapshot - the current scope snapshot.
 * @returns the reference to address.
 */
function refOf(snapshot: SettingsFormScopeSnapshot<E2bSettings>): string {
  const declared = snapshot.value?.apiKeyEnv
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
}
