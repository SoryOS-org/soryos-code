// @vitest-environment jsdom
/** The E2B page as the Plugins page renders it: its key control, its five fields, and their resets. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { E2bCard, type E2bCardProps } from '../src/client/E2bCard.tsx'
import type { E2bCardState } from '../src/client/e2b-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

function fullState(state: Partial<E2bCardState> = {}): E2bCardState {
  return {
    ...settled,
    apiKeyEnv: field('E2B_API_KEY'),
    domain: field(''),
    template: field('base'),
    timeoutMs: field('3600000'),
    requestTimeoutMs: field('30000'),
    apiKey: field(''),
    apiKeyConfigured: false,
    apiKeyWritable: true,
    ...state,
  }
}

describe('E2bCard', () => {
  function renderE2b(state: Partial<E2bCardState> = {}) {
    const store = createSnapshotStore<E2bCardState>(fullState(state))
    const actions = cardActions()
    const props = { ...actions, view: 'page', t, useE2bCard: bindSnapshotSelector(store) } as E2bCardProps
    render(<E2bCard {...props} />)
    return actions
  }

  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<E2bCardState>(fullState())
    const props = { ...cardActions(), view: 'summary', t, useE2bCard: bindSnapshotSelector(store) } as E2bCardProps
    render(<E2bCard {...props} />)

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.apiKey)).toBeNull()
  })

  it('reports whether a key is configured without ever showing one', () => {
    renderE2b({ apiKeyConfigured: true })

    expect(screen.getByText(en.apiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderE2b({ writable: false })

    const key = screen.getByLabelText(en.apiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.template)).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'e2b-secret' } })

    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'e2b-secret')
  })

  it('disables the key control when the reference itself is not writable', () => {
    // A key coming from the process environment: the settings document is
    // writable, the credential is not.
    renderE2b({ apiKeyConfigured: true, apiKeyWritable: false })

    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.template)).toHaveProperty('disabled', false)
  })

  it('stages the reference, domain, template, and both deadlines', () => {
    const actions = renderE2b({
      apiKeyEnv: field('E2B_API_KEY', { overridden: true }),
      domain: field('e2b.example.test', { overridden: true }),
      template: field('base', { overridden: true }),
      timeoutMs: field('3600000', { overridden: true }),
      requestTimeoutMs: field('30000', { overridden: true }),
    })

    fireEvent.change(screen.getByLabelText(en.apiKeyEnv), { target: { value: 'SANDBOX_KEY' } })
    fireEvent.change(screen.getByLabelText(en.domain), { target: { value: 'other.test' } })
    fireEvent.change(screen.getByLabelText(en.template), { target: { value: 'v2' } })
    fireEvent.change(screen.getByLabelText(en.timeoutMs), { target: { value: '60000' } })
    fireEvent.change(screen.getByLabelText(en.requestTimeoutMs), { target: { value: '5000' } })
    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(5)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['apiKeyEnv', 'SANDBOX_KEY'],
      ['domain', 'other.test'],
      ['template', 'v2'],
      ['timeoutMs', '60000'],
      ['requestTimeoutMs', '5000'],
    ])
    expect(actions.resetField.mock.calls).toEqual([
      ['apiKeyEnv'], ['domain'], ['template'], ['timeoutMs'], ['requestTimeoutMs'],
    ])
  })
})
