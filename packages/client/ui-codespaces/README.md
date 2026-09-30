---
description: "Codespaces environment configuration panel: repository/branch/machine pickers, lifecycle controls, and the GitHub authorization flow bridge"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-codespaces

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-codespaces` provides the Codespaces environment configuration panel for the web GUI. It exposes a React panel component that lets users configure their Codespaces environment (repository, branch, machine selection), control the connection lifecycle (connect, disconnect, reconnect, stop, remove), and complete the GitHub authorization flow through an interactive bridge. Every operation is server-side via the `ctx.remote.codespaces` namespace; the panel never sees a GitHub token.

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

This is a **client-only** package; it provides browser-side React components for the web GUI. The panel is designed to be used within the workspace settings or sidebar of the DeepSeek Harness web application.

### Registering the panel

The package exports a slot contribution. In a profile that includes the Codespaces bundle, the panel registers itself into the appropriate slot in the workspace settings UI.

### Basic usage in workspace settings

```tsx
import { CodespacesPanel, CodespacesPanelProvider } from '@deepseek-ai/dsh-client-ui-codespaces'
import { useCurrentWorkspace } from '@deepseek-ai/dsh-client-ui-workspace'

function WorkspaceCodespacesSettings() {
  const workspace = useCurrentWorkspace()
  if (workspace === undefined) return null
  
  return (
    <CodespacesPanelProvider ctx={useContext()}>
      <CodespacesPanel workspaceId={workspace.id} />
    </CodespacesPanelProvider>
  )
}
```

### Panel features

The panel provides:

1. **Configuration Form**
   - Repository picker with search/filter
   - Branch picker for the selected repository
   - Machine type picker for the selected repository
   - Optional: devcontainer path, idle timeout, retention period, location, display name

2. **Connection Controls**
   - Connect button - provisions codespace and establishes connection
   - Disconnect button - closes SSH connection (codespace keeps running)
   - Reconnect button - re-establishes connection after network loss
   - Stop button - stops the codespace (filesystem survives)
   - Remove button - deletes codespace and clears configuration (destructive)

3. **Status Display**
   - Current lifecycle state
   - Configured repository/branch/machine
   - Provisioned codespace name
   - Workspace URL (once connected)
   - GitHub authorization status

4. **GitHub Authorization Flow**
   - Device flow support for GitHub OAuth
   - Interactive prompt/response for authorization codes
   - Progress display for authorization settlement

### Error handling

The panel displays server-side errors returned from the remote methods. All error messages are safe to show to users (no tokens or secrets).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is a **React-based client plugin** that communicates with the host via Typert remote method calls.

### File structure

```
packages/client/ui-codespaces/
├── src/
│   ├── index.ts              # Plugin entry (apply function)
│   └── client/
│       ├── index.tsx        # Main panel component and provider
│       └── ...              # Supporting components
├── tsconfig.json
├── tsdown.config.ts
└── package.json
```

### Plugin registration

The plugin registers into the client via `apply(ctx)` in `src/index.ts`. It:
- Exports the `CodespacesPanel` component
- Exports the `CodespacesPanelProvider` component
- Registers the panel into the workspace settings slot

### React component hierarchy

```
CodespacesPanelProvider (context provider)
└── CodespacesPanel (main panel)
    ├── ConfigurationForm
    │   ├── RepositoryPicker
    │   ├── BranchPicker
    │   └── MachinePicker
    ├── ConnectionControls
    │   ├── ConnectButton
    │   ├── DisconnectButton
    │   ├── ReconnectButton
    │   ├── StopButton
    │   └── RemoveButton
    ├── StatusDisplay
    └── AuthorizationModal
        ├── NoticeDisplay
        └── PromptForm
```

### State management

The panel uses React hooks for state:
- `useState` for form configuration
- `useState` for panel status (derived from server)
- `useState` for authorization flow state
- `useEffect` for initial status load
- `useCallback` for refresh handler

### Remote method consumption

The panel consumes the following methods from `ctx.remote.codespaces`:

| Method | Purpose |
|--------|---------|
| `getStatus(workspaceId)` | Read current environment status |
| `listRepositories()` | List user's repositories |
| `listBranches(repository)` | List repository branches |
| `listMachines(repository)` | List available machine types |
| `configure(workspaceId, config)` | Save configuration |
| `connect(workspaceId)` | Connect and provision |
| `reconnect(workspaceId)` | Reconnect after network loss |
| `disconnect(workspaceId)` | Disconnect (close SSH) |
| `stop(workspaceId)` | Stop codespace |
| `remove(workspaceId)` | Delete codespace |
| `getAuthorization()` | Get GitHub auth status |
| `followAuthorization(method, signal)` | Stream auth flow |
| `answerAuthorization(promptId, answer)` | Answer auth prompt |
| `cancelAuthorization()` | Cancel auth flow |

### Authorization flow

The authorization flow uses an async iterable pattern:

1. User clicks "Authorize GitHub" or similar
2. Panel calls `followAuthorization({ method: 'device' }, signal)`
3. For each frame in the stream:
   - `notice` frames: display informational message to user
   - `prompt` frames: show prompt, collect user answer, call `answerAuthorization()`
   - `settlement` frames: display success/failure, complete flow
4. Panel refreshes status to show updated authorization state

### Token security

The panel **never** sees or handles GitHub tokens. All token operations happen server-side. The panel only:
- Receives prompts for user input (e.g., device code)
- Sends user answers back to the server
- Displays authorization status (configured/not configured)

### Styling

The panel uses the shared UI primitives and CSS Modules from the client framework. It follows the [web styling guidelines](../../../docs/web-styling.md).

### dsh.client configuration

The package declares itself as a client plugin in `package.json`:

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-api-codespaces-controller",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ]
    }
  }
}
```

The client module exports:
- `CodespacesPanel` - The main React component
- `CodespacesPanelProvider` - Context provider for the remote namespace

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Codespaces controller package](../../api/codespaces-controller/README.md) — the server-side API this panel consumes.
- [Client UI framework](../../client/README.md) — the React client framework.
- [UI primitives package](../../client/ui-primitives/README.md) — shared React controls.
- [Slots system](../../client/ui-slots/README.md) — where this panel registers.

<a id="model-experience"></a>
## Model Experience

None, as this package is a browser-side UI plugin layer.

#### KV Cache effect

None; this package is UI-only.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The panel assumes the Codespaces bundle is installed; it will not function without the server-side services.
- Repository list is not paginated; users with many repositories may experience slow loading.
- Only one workspace's Codespaces configuration can be edited at a time.
- The panel does not support bulk operations across multiple workspaces.
- Authorization flow is modal and blocks other interactions.

<details>
<summary>Working context for maintainers — click to expand</summary>

This is a **client feature plugin**. It owns:
- Browser-side React components
- User-facing strings (must be localized)
- Visual presentation and interaction

It does NOT own:
- Server-side logic
- Storage or state persistence
- Token or credential handling
- Model-visible behavior

The panel should be registered into a slot provided by a parent package (typically the workspace settings UI).

</details>
