/**
 * Codespaces environment panel plugin, node half. Pure UI plugin: the empty
 * apply exists so the plugin appears in the host cordis.yml / Loader; the
 * browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration.
 * @module @deepseek-ai/dsh-client-ui-codespaces
 */

/** Host plugin body — no host-side behavior for the Codespaces panel plugin. */
export function apply(): void {}
