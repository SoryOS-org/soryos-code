---
description: "The E2B remote sandbox provider's settings page on the dsh web client's Plugins page: its API key, credential reference, template, and deadlines."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-e2b

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Remote sandbox** in the Official group to set the E2B connection's key, the reference naming that key, the sandbox template, and the two deadlines. The page stages what is typed and writes it only on save; the key is written through the credentials domain rather than the settings document, so its literal never rides a response. The page exists while the Host serves the `e2b` namespace.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The **Remote sandbox** card in the Official group opens the page. **API key** starts blank on every load and reports only whether a key is configured; a blank draft keeps the stored key, and the control is disabled when the credential cannot be written from here, such as a key the process environment supplies. **Key reference** names where the key is stored and defaults to `E2B_API_KEY`; changing it addresses a different credential. **Control-plane domain**, **Sandbox template**, **Sandbox lifetime**, and **Request deadline** render the effective value, carry an **Overridden** badge with **Reset to default** once overridden, and save as a reset when emptied. Nothing is written until **Save**; leaving the page drops the drafts.

The sandbox **workspace** directory is not on this page: the E2B preset owns it, because it is deployment identity rather than a per-session knob.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `e2b` namespace through `ctx.configForms.get` and keeps the staged form in `E2bCardController` over the shared `SettingsFormModel` of `ui-primitives`, with the key as the form's one secret control: its write goes to `remote.credentials.set` under the reference the section's `apiKeyEnv` names (`E2B_API_KEY` when it names none), and success is read back from `remote.credentials.describe`. The controller re-reads the credential when the scope changes and when the Host reports `credentials/reference-updated` for the watched reference, since a key written on another surface changes no settings section. The page registers `E2bCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form model and fields the page renders.
- [credentials](../../credentials/README.md) — the credential-reference seam the key writes through.
- [e2b](../../e2b/e2b/README.md) — the connection that registers the `e2b` namespace and resolves the key.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The workspace directory is not editable here** — `E2bConnection.Config.workspace` stays an ordinary field, so the preset's value is the only one a deployment ships; editing it means editing the profile.
- **No sandbox lifecycle control** — the page configures the connection but does not create, pause, resume, or destroy a sandbox; those are service calls an agent makes.
- **Runtime invariant:** No companion is published. The page holds no owned relationship of its own: what it shows derives from the settings mirror and the credentials domain, and what it writes the Host validates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
