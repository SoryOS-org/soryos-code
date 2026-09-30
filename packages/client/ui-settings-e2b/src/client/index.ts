/**
 * The E2B remote sandbox settings page, browser half: its API key, the
 * reference naming that key, the template, and both deadlines over the `e2b`
 * namespace the connection registers. The page registers into the Plugins
 * page's `plugins.item` slot while the Host serves that namespace, so a
 * deployment without the E2B provider shows no trace of it.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { E2bCard } from './E2bCard.tsx'
import { E2B_NS, E2bCardController } from './e2b-card-controller.ts'
import { en, zh, type E2bSettingsLocaleKey } from './locales.ts'

export type { E2bCardProps } from './E2bCard.tsx'
export type { E2bCardFace, E2bCardState, E2bSettings } from './e2b-card-controller.ts'
export type { E2bSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** E2B remote sandbox settings page copy. */
    'settings.e2b': E2bSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.e2b'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/**
 * Mount the E2B settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-e2b: dictionaries')
  const card = new E2bCardController(ctx.configForms.get(E2B_NS), ctx)
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-e2b: form subscription')
  // The credential the page reports is not part of any settings section, so
  // its scope publishes nothing when one is written. This is the only signal
  // that a key written on another surface reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { card.refreshCredential(ref) }),
    'ui-settings-e2b: credential invalidations',
  )
  ctx.effect(() => ctx.configForms.whileServed([E2B_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'e2b', order: 50, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, E2bCard))), 'ui-settings-e2b: page')
}
