/** Locale bundles for the E2B remote sandbox provider's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type E2bSettingsLocaleKey =
  | 'title' | 'description'
  | 'apiKey' | 'apiKeyHint' | 'apiKeySet' | 'apiKeyUnset'
  | 'apiKeyEnv' | 'apiKeyEnvHint'
  | 'domain' | 'domainHint'
  | 'template' | 'templateHint'
  | 'timeoutMs' | 'timeoutMsHint'
  | 'requestTimeoutMs' | 'requestTimeoutMsHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<E2bSettingsLocaleKey, string> = {
  title: 'Remote sandbox',
  description: 'Run commands and files inside an isolated E2B sandbox.',
  apiKey: 'API key',
  apiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  apiKeySet: 'A key is configured.',
  apiKeyUnset: 'No key is configured; the sandbox cannot start until one is.',
  apiKeyEnv: 'Key reference',
  apiKeyEnvHint: 'Name the key is stored under, such as E2B_API_KEY.',
  domain: 'Control-plane domain',
  domainHint: 'Leave blank to use the default E2B domain.',
  template: 'Sandbox template',
  templateHint: 'Template name or ID new sandboxes are created from.',
  timeoutMs: 'Sandbox lifetime (ms)',
  timeoutMsHint: 'How long a sandbox stays running before E2B stops it.',
  requestTimeoutMs: 'Request deadline (ms)',
  requestTimeoutMsHint: 'Deadline applied to every E2B control-plane call.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<E2bSettingsLocaleKey, string> = {
  title: '远程沙箱',
  description: '在隔离的 E2B 沙箱内运行命令与文件操作。',
  apiKey: 'API Key',
  apiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  apiKeySet: '已配置密钥。',
  apiKeyUnset: '未配置密钥；配置之前沙箱无法启动。',
  apiKeyEnv: '密钥引用名',
  apiKeyEnvHint: '密钥存储所用的名称，例如 E2B_API_KEY。',
  domain: '控制平面域名',
  domainHint: '留空则使用 E2B 默认域名。',
  template: '沙箱模板',
  templateHint: '创建新沙箱时使用的模板名称或 ID。',
  timeoutMs: '沙箱存活时长（毫秒）',
  timeoutMsHint: '沙箱保持运行的时长，超过后由 E2B 停止。',
  requestTimeoutMs: '请求超时（毫秒）',
  requestTimeoutMsHint: '每一次 E2B 控制平面调用的截止时间。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: E2bSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
