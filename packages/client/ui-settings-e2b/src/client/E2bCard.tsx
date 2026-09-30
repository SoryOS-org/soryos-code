/**
 * The E2B remote sandbox provider's settings page: its key — written through
 * the credentials domain, never into the settings section, so the literal never
 * rides a response — the reference that names it, and the template and
 * deadlines a sandbox is created with.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsSecretField, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { E2bCardFace } from './e2b-card-controller.ts'

/** Props the renderer binds for the E2B page. */
export type E2bCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.e2b'>
  & InjectFace<E2bCardFace>

/**
 * Render the E2B provider's one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function E2bCard(props: E2bCardProps) {
  const { t } = props
  const state = props.useE2bCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsSecretField
        id="plugin-config-e2b-key"
        label={t('apiKey')}
        hint={t('apiKeyHint')}
        // The credentials domain accepts a key even when the settings document
        // itself is read-only; they are separate stores with separate refusals.
        // Its own writability is what disables this control — a key sourced
        // from the process environment cannot be written from here.
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
      <SettingsValueField
        id="plugin-config-e2b-key-ref"
        label={t('apiKeyEnv')}
        hint={t('apiKeyEnvHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.apiKeyEnv}
        onEdit={(text) => { props.edit('apiKeyEnv', text) }}
        onReset={() => { props.resetField('apiKeyEnv') }}
      />
      <SettingsValueField
        id="plugin-config-e2b-domain"
        label={t('domain')}
        hint={t('domainHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.domain}
        onEdit={(text) => { props.edit('domain', text) }}
        onReset={() => { props.resetField('domain') }}
      />
      <SettingsValueField
        id="plugin-config-e2b-template"
        label={t('template')}
        hint={t('templateHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.template}
        onEdit={(text) => { props.edit('template', text) }}
        onReset={() => { props.resetField('template') }}
      />
      <SettingsValueField
        id="plugin-config-e2b-timeout"
        label={t('timeoutMs')}
        hint={t('timeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.timeoutMs}
        onEdit={(text) => { props.edit('timeoutMs', text) }}
        onReset={() => { props.resetField('timeoutMs') }}
      />
      <SettingsValueField
        id="plugin-config-e2b-request-timeout"
        label={t('requestTimeoutMs')}
        hint={t('requestTimeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.requestTimeoutMs}
        onEdit={(text) => { props.edit('requestTimeoutMs', text) }}
        onReset={() => { props.resetField('requestTimeoutMs') }}
      />
    </SettingsForm>
  )
}
