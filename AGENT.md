# AGENT.md — Intégration E2B dans SoryOS-IA

Statut : Phases 1 à 4 et 6 terminées (audit + cartographie + sandbox E2B + `fs-e2b` + `subprocess-e2b` livrés avec docs et gates). Aucun code produit avant la cartographie, conformément à la mission.

---

## Phase 1 — AUDIT

### Objectif

Inspecter entièrement SoryOS-IA, identifier les modifications par rapport à DeepSeek Harness, les points d'extension naturels, et tout code E2B existant — sans écrire de code.

### Architecture étudiée

- **Monorepo** : fork propre de DeepSeek Harness (`origin = SoryOS-org/soryos-code`, `master` à jour, `working tree clean`, aucune divergence locale, aucune branche feature). Les log de commits sont ceux de l'upstream `deepseek-harness`.
- **Cordis / plugins** : tout est plugin ; composition par **profils** (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`) empilant des **bundles** (`dsh-base`, `dsh-web-app`, …) via des `cordis.patch.yml` (une ligne = un plugin + `config` validé ; le patch remplace la ligne entière). Référence : `docs/architecture.md:15-41`.
- **Capability seams** (`docs/architecture.md:129-135`, `docs/capability-seams.md`) : chaque capacité a Service Definition / Service Provider / Consumer. L'invariant central : `ctx.fs` + `ctx.subprocess` forment **un seul « execution world »** (même namespace de chemins, mêmes processus) ; Bash, PTY, LSP et les sous-agents suivent automatiquement (`docs/architecture.md:133`).
- **Request/spec split** : `ShellExecutor.resolve(request) → spec` puis `execute(spec)` sans défaut implicite (`packages/shell/shell/src/index.ts:84-93`).
- **Cycle de vie** : Session = log append-only ; Agent = handle live ; les Tools reçoivent leurs capacités par `static inject` / `ctx.inject` depuis la composition de l'Agent.
- **Frontend unique** : `apps/web` (Vite) + `apps/desktop` (Electron sur la même Web app) ; communication par Remote/typert sur la gateway (`/api` + WebSocket `/api/remote.mux`).

### Packages utilisés (audités)

| Package | Rôle | `ctx` |
|---|---|---|
| `packages/fs/fs` | Service Definition `FileSystem` (`src/index.ts:87`) | `ctx.fs` |
| `packages/fs/fs-local`, `fs-sandbox` | Providers locaux (base : `dsh-fs-sandbox` mounté `bundle/base/cordis.patch.yml:517`) | |
| `packages/shell/shell` | Service Definition `ShellExecutor` (`src/index.ts:64`) | `ctx.shell` |
| `packages/shell/bash-local`, `bash-sandbox` | Providers ; `bash-local` spawn via `ctx.subprocess` | |
| `packages/subprocess/subprocess` | Service Definition `SubprocessRuntime` (`src/index.ts:117`) : `spawn`, `spawnTerminal`, handles stdio/control/exit | `ctx.subprocess` |
| `packages/subprocess/subprocess-local` | Provider local (cgroups/Job, node-pty) | |
| `packages/sandbox/sandbox` | Service Definition `SandboxProvider.confine(argv, policy)` — confinement **same-world** (`src/index.ts:1-10` : un monde distant **remplace** ce séam au lieu de le fournir) | `ctx.sandbox` |
| `packages/sandbox/sandbox-policy` | Déploiement : mode + `workspaceRoot` (défaut `process.cwd()` — chemin hôte) | `ctx.sandboxPolicy` |
| `packages/terminal/terminal` + `terminal-bash` | Registre de terminaux persistants ; backend spawn via `ctx.subprocess.spawnTerminal` | `ctx.terminals` |
| `packages/api/terminal-controller` | Terminal navigateur (Remote) ; résout `subprocess` **depuis `agent.ctx`** (`src/index.ts:331-337`) | `ctx.terminalController` |
| `packages/api/workspace-files` | Explorateur de fichiers navigateur (lecture seule) ; résout `ctx.fs` **racine** (`src/index.ts:184`) | `ctx.workspaceFiles` |
| `packages/ssh/*` | **Family remote existante** : `ssh` (connexion + helper mini-Cordis distant), `fs-ssh`, `subprocess-ssh`, `sandbox-ssh` — le template à cloner | `ctx.ssh` |
| `packages/preset/agent-preset(+registry)` | Presets par session ; une row de service dans un preset exige un realm `isolate` (`docs/architecture.md:145`, `mount.ts:78-88`) | `ctx.agentPresets` |
| `packages/workspace`, `api/session-controller` | Workspace (realpath hôte) ; création de session fait `mkdir(cwd)` **hôte** (`session-controller/src/agent.ts:481`) | `ctx.workspaceRegistry` |
| `packages/settings`, `redact.ts` | Config + secrets : champs `role('secret')` retirés par `redactSecrets` des dumps/UI | |

### Code E2B déjà présent

**Aucun.** Vérifié : zéro occurrence `e2b` dans le code, les `cordis.patch.yml`, les manifests et le lockfile (seuls des hashs hexadécimaux matchent le grep). Le dépôt a **retiré** une family provider E2B en 2026-09-11 : `.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.md` :

- L'expérimentation précédente fournissait exactement **fs + subprocess + sandbox** providers (les 3 rows à remplir), avec `e2b@2.29.1`.
- Raison du retrait : le confinement PTC Node exige un canal de contrôle bidirectionnel (fd-7, `SUBPROCESS_CONTROL_FD`) que le SDK E2B ne transportait pas ; le SDK retenait stdout/stderr complets (risque mémoire).
- **Conditions de réintroduction** (note §« Reintroduction conditions ») : cas d'usage concret, preuves sur coordonnées fichiers/process partagées, politique, rétention bornée du transport, fermeture de canal précise, annulation gérée ; perte de connexion ≠ rejouer un programme potentiellement exécuté.
- La note affirme explicitement que le retrait **n'implique pas** qu'E2B ne peut pas supporter un transport adapté, et que les interfaces partagées (`fs`, `subprocess`, terminaux **asynchrones**) ont été conservées *pour* des providers distants.

### Fichiers modifiés

Aucun (phase d'audit uniquement).

### Décisions techniques

1. Respecter les séams DSH : pas d'`E2BAgent`, pas d'`E2BTerminal`, pas d'UI E2B ; E2B = provider family derrière `ctx.fs` / `ctx.subprocess` / `ctx.sandbox`.
2. La famille **SSH est le template de référence** pour un backend distant (structure de package, helper, transport, tests).
3. Le SDK E2B à intégrer : `e2b` npm **2.51.0** (actuel), surface `Sandbox`/`commands`/`files`/`pty`.
4. Le séam `ctx.sandbox` : une VM E2B **remplace** le confinement (le provider E2B peut se déclarer « l'isolation est la VM », au lieu de wrappper argv avec bwrap).

### Tests

Phase non-code : vérifications d'exécution effectuées — `git status`/`git log` (fork propre), grep `e2b` exhaustif (aucun code), lecture des notes/sous-systèmes concernés, `npm view e2b` (2.51.0), lecture du code des séams. Aucune suite de tests à lancer pour un audit lecture-seule.

### Résultats

- **L'UI est déjà backend-agnostic** : un seul terminal (`packages/client/ui-sidebar-terminal`, xterm unique du repo) → `terminal-controller` → `agent.ctx.get('subprocess')` → `spawnTerminal`. Un seul explorateur (`ui-sidebar-files` + `ui-sidebar-documentpreview`) → `remote.workspaceFiles.*` → `ctx.fs`. Échanger la row provider suffit : zéro changement client (`docs/architecture.md:133`).
- **Le provider remote existant (SSH) prouve le modèle** : `fs-ssh`/`subprocess-ssh`/`sandbox-ssh` + helper distant ; non monté par les profils shipped (opt-in).
- **La sélection par session est documentée par l'architecture** : preset agent + realm `isolate` (`docs/architecture.md:145`) ; le mécanisme existe (`agent-preset-registry`, testé dans `tests/registry.spec.ts:207`) mais n'est encore utilisé par aucune row `fs`/`subprocess`.
- **Processus longs** : `SubprocessHandle` (`stdin/stdout/stderr/done/terminate/waitForExit`) et `SubprocessTerminalHandle` (`write/resize/inspectForeground/signalForeground/terminate`) sont déjà asynchrones et contrats-compatible distant (gardés volontairement pour providers remote, note E2B §Decision).

### Problèmes (gaps identifiés, à traiter plus tard)

| # | Gap | Référence |
|---|---|---|
| 1 | `WorkspaceFiles` lit `ctx.fs` **racine** alors que le terminal lit `agent.ctx` — un fs E2B « par session » ne suivrait pas l'explorateur | `api/workspace-files/src/index.ts:184` vs `api/terminal-controller/src/index.ts:331` |
| 2 | Création de session : `mkdir(cwd)` **hôte** sur un cwd qui serait un chemin E2B | `api/session-controller/src/agent.ts:481` |
| 3 | `sandboxPolicy.workspaceRoot = process.cwd()` (chemin hôte) | `bundle/base/cordis.patch.yml:227-232` |
| 4 | Workspace : realpath hôte comme canon d'unicité | `workspace/src/paths.ts:17-60` |
| 5 | Directory picker / dossier par défaut / « Ouvrir dans l'app » = FS hôte | `api/workspace-controller/src/directory-picker.ts`, `default-directory.ts` ; gap documenté `docs/subsystems/ssh.md:25-27` |
| 6 | PTC (fd-7) indisponible sur le transport E2B — le profil `ptc` ne peut pas tourner dans un monde E2B sans travail de transport supplémentaire | note de retrait §Problème |
| 7 | Deux providers `ctx.fs` simultanés = throw (`vendor/cordis/src/reflect.ts:285`) — bascule par realm `isolate` ou remplacement de row, jamais les deux | |

### Prochaine phase

Phase 2 — cartographie (produite ci-dessous) ; puis Phase 3 (sandbox E2B) après validation du modèle de sélection.

---

## Phase 2 — CARTOGRAPHIE

### Objectif

Relier chaque package DeepSeek/SoryOS à la capability et à l'API E2B correspondante, et figer les points d'intégration avant tout code.

### Cartographie DeepSeek → SoryOS → capability → E2B API

| Package DeepSeek (séam) | Package SoryOS cible | Capability | API E2B (SDK 2.51.0) |
|---|---|---|---|
| `packages/fs/fs` (`FileSystem`) | `packages/fs/fs-e2b` (nouveau, clone la forme de `ssh/fs-ssh`) | `ctx.fs` : resolve/stat/read/stream/listDir/writeText/editText/watch | `sandbox.files` : `read`, `write`, `list`, `getInfo`, `makeDir`, `remove`, `rename`, `exists`, `watchDir` |
| `packages/subprocess/subprocess` (`SubprocessRuntime`) | `packages/subprocess/subprocess-e2b` (nouveau, clone `ssh/subprocess-ssh`) | `ctx.subprocess` : `resolveExecutable`, `spawn`, `spawnTerminal`, handles | `sandbox.commands` : `run`/`start` (opts `cwd`,`envs`,`timeoutMs`,`background`,`onStdout`,`onStderr`,`stdin`), `connect(pid)`, `kill`, `sendStdin`, `list` ; `sandbox.pty` : `create`, `sendInput`, `resize`, `connect`, `kill` |
| `packages/shell/shell` (`ShellExecutor`) | **réutilise `bash-local`** (`resolve` pur + spawn via `ctx.subprocess`) | `ctx.shell` : `resolve` → `execute` | transitif via `commands` |
| `packages/sandbox/sandbox` (`SandboxProvider`) | `sandbox-e2b` (nouveau) : `confine` = passthrough, l'isolation est la VM ; ou omission de row selon la composition | `ctx.sandbox` | sandbox Firecracker = frontière d'isolation |
| `packages/sandbox/sandbox-policy` | row adaptée : `workspaceRoot` = chemin **dans** le sandbox (config, pas `process.cwd()`) | `ctx.sandboxPolicy` | — |
| `packages/terminal/terminal` + `terminal-bash` | **inchangés** (spawn via `ctx.subprocess.spawnTerminal`) | `ctx.terminals` | `sandbox.pty` |
| `packages/api/terminal-controller`, `packages/api/workspace-files` | **inchangés côté UI** ; gap #1 à corriger (résoudre fs depuis l'agent/session) | Remote terminal + fichiers | — |
| lifecycle sandbox | `packages/e2b/e2b` (livré en Phase 3 ; Service Definition `ctx.e2b` : create/connect/pause/resume/destroy/status + workspace-init) | gestion du cycle de vie par session | `Sandbox.create`, `Sandbox.connect`, `pause`, `kill`, `files.makeDir`, `sandboxId` |
| `packages/ssh/*` | **template de structure** (pas de code à réutiliser tel quel) | pattern provider distant | — |
| `packages/settings` / secrets | config plugin : `apiKey` avec `role('secret')` + fallback env `E2B_API_KEY` (précédent : `apiKeyEnv` `bundle/base/cordis.patch.yml:480`) | secrets | auth `X-API-Key` E2B |

### Ce qui ne change jamais

Agent, boucle, Session/log, Tools (`tool-fs`, `tool-bash`, `tool-terminal`…), LLM, UI (terminal, explorateur, chat), SDK — tous restent identiques ; seul le provider derrière `ctx.fs`/`ctx.subprocess`/`ctx.sandbox` change. Aucun `if e2b` dans le core : `Agent → capability → provider → E2B`.

### API E2B étudiées (SDK + runtime)

- **SDK JS `e2b`** : `Sandbox.create({template, timeoutMs, envs, metadata})`, `Sandbox.connect(id)`, `sandbox.kill()`, `pause()`, `getInfo()`, `isRunning()`, `setTimeout()`, `getHost(port)` (exposition de ports), snapshots.
- **`sandbox.commands`** : run one-shot (retour `CommandResult` stdout/stderr/exitCode), run **background** (retour `CommandHandle` : `wait`, `kill`, `pid`), reconnexion `connect(pid)` inter-processus, `sendStdin`, `list`.
- **`sandbox.pty`** : pseudo-terminaux avec `sendInput`/`resize` — correspond à `spawnTerminal`.
- **`sandbox.files`** : lecture/écriture/listing/mkdir/remove/rename/watch.
- **Runtime E2B** (`e2b-dev/runtime` ARCHITECTURE.md) : SDK → API REST → orchestrator → Firecracker microVM → **envd** (agent in-VM : process service stream stdout/stderr/stdin/signaux/PTYs ; filesystem service stat/list/make/move/remove/watch) ; auto-pause/auto-resume ; ports via `port-sandboxid.domain`. On consomme le SDK, on ne recopie pas le runtime.
- **Code Interpreter** : hors périmètre (module `runCode` séparé, pas nécessaire pour un coding agent).

### Modèle d'exécution retenu

```text
Agent (inchangé)
  ├── tool-fs / workspaceFiles → ctx.fs       ──┐
  ├── tool-bash / hooks        → ctx.shell     │  provider E2B
  ├── terminal UI + tool-term  → ctx.subprocess┤  (fs-e2b + subprocess-e2b
  ├── LSP / subagents          → ctx.subprocess│   + sandbox-e2b)
  └── argv confinement         → ctx.sandbox   ─┘
                │
                ▼
        Sandbox E2B (workspace = cwd de la session)
```

- **Cible : sélection par session** via **preset agent + realm `isolate`** (mécanisme documenté `docs/architecture.md:145`) : une session « E2B » compose les providers E2B dans la composition de son Agent ; le terminal suit (`agent.ctx`), l'explorateur suivra après correction du gap #1. Une session locale continue d'utiliser les rows racine — les deux coexistent sans `if e2b`.
- **Alternative valide pour le premier jalon** : remplacement de rows au niveau profil/patch (`cordis.patch.yml`) — tout le processus tourne dans le monde E2B, plus simple, mais sans cohabitation local/E2B dans la même instance.
- Le **cwd de la session** pointe dans le sandbox (`/home/user/…`) ; l'initialisation du projet (clone/création) se fait dans le sandbox — jamais « PC → copie → E2B » comme architecture obligatoire.

### Gaps à résoudre par phase (issus de l'audit)

1. fs racine vs fs par session (gap #1) — Phase 8.
2. `mkdir(cwd)` hôte en création de session (gap #2) — Phase 4/7.
3. `sandboxPolicy.workspaceRoot` hôte (gap #3) — Phase 5.
4. Workspace realpath / directory picker hôte (gaps #4-5) — Phase 8 (sélecteur de workspace E2B : chemins distants, pas de picker OS hôte).
5. PTC hors sujet en E2B (gap #6) — documenté, non implémenté.
6. Réponse aux conditions de réintroduction de la note E2B (rétention bornée, fermeture de canal, annulation) — tests dédiés Phase 6/7.

### Plan de phases (adapté)

- **Phase 3 — E2B sandbox** : **livrée** — package `e2b` (lifecycle : create/connect/pause/resume/destroy/status, config `apiKey` secret, workspace init), tests unitaires + composition réelle + e2e live (voir Phase 3 ci-dessous).
- **Phase 4 — Filesystem** : `fs-e2b` branché sur `sandbox.files`, tests write/read/list/mkdir/delete/rename.
- **Phase 5 — Shell** : vérifier `bash-local` au travers de `subprocess-e2b` (pwd/ls/echo/git), row `sandbox-policy` distante.
- **Phase 6 — Subprocess** : `subprocess-e2b` (spawn/stream/stop/exit code + `spawnTerminal` via `pty`), tests processus longs (`npm run dev`), conditions de réintroduction (rétention, annulation, perte de connexion).
- **Phase 7 — Agent tools** : preset `e2b` + `isolate`, cwd session distant, `mkdir` conditionnel, tests `Agent → ctx.fs/shell/subprocess/sandbox → E2B`.
- **Phase 8 — Frontend** : **aucune UI nouvelle** ; corriger gap #1 (workspaceFiles → fs de la session), workspace E2B côté explorateur/terminal, sélecteur d'environnement (précedent `ui-permission-presets` / settings card).
- **Phase 9 — End-to-end** : scénario complet (sélecteur E2B → sandbox → projet → terminal → build → tests → serveur dev → git status → destruction).
- **Phase 10 — Nettoyage** : doublons, adapters concurrents, code expérimental.

### Tests

Phase 2 = document ; validation : relecture croisée des références `file:line` contre le dépôt (fait, voir Phase 1). Les tests exécutables arrivent avec Phase 3.

### Résultats

Cartographie produite, points d'extension identifiés, aucun code modifié.

### Problèmes

Le seul fork de design à trancher avant Phase 3 : **sélection par session (preset + isolate)** recommandé vs **profil entier** pour le premier jalon — décision à confirmer.

### Prochaine phase

Phase 3 — E2B sandbox ; livrée, rapport ci-dessous.

---

## Phase 3 — SANDBOX E2B (livrée)

### Objectif

Livrer la seam de lifecycle E2B derrière `ctx.e2b` : un package montable, ses tests, sa documentation et ses gates — sans UI ni agent parallèle.

### Livrables

- **Package** : `packages/e2b/e2b` (`@deepseek-ai/dsh-e2b`, v `0.1.7-rc.2`, SDK `e2b@2.51.0`, deps `@deepseek-ai/schemastery`). Groupe nouveau `packages/e2b/`.
- **Service** : `E2bConnection` (`ctx.e2b`, déclaré par merge `Context`) dans `src/index.ts` — opérations `create` / `connect(id)` / `pause` / `resume` / `destroy` / `initWorkspace` sérialisées par une file unique, getters `state` / `sandbox`, `status()` (état local `absent|starting|ready|paused|failed`, `sandboxId`, dernier `error`), dispose = détachement local sans appel réseau (rétention bornée côté E2B via `timeoutMs`).
- **Config** (validée par le Loader au montage, standard-schema) : `apiKey` (`role('secret')`), `apiKeyEnv` (défaut `E2B_API_KEY`), `domain`, `template`, `timeoutMs` (1000–86 400 000), `requestTimeoutMs` (1000–2 147 483 647), `workspace` requis. Clé absente/vidée = échec nommé de la première opération ; zéro requête au load/dispose.
- **Tests** : `tests/lifecycle.spec.ts` (11 cas : ownership, options+signal, clé env, échecs enregistrés, concurrence/queue, workspace, dispose, validation), `tests/composition.spec.ts` (2 cas **réels** : montage Loader+Include d'un `cordis.yml` → `ctx.e2b` + rejet d'une config invalide), fixture SDK `tests/fixtures/e2b.ts`, e2e `tests/live.e2e.ts` (`describe.skipIf(!E2B_API_KEY)`, create→initWorkspace→pause→resume→destroy, `timeoutMs: 600_000`).
- **Couverture** : 100 % stmts/branches/functions/lines sur `src/index.ts` (99/99, 44/44), 13 tests verts.
- **Docs** : paires `packages/e2b/e2b/README.md|.zh.md|.i18n.yaml` (kind `package-reference`, phrase audited « None, as … », phrase d'omission d'invariant requise par `verify-package-invariants`), paires `packages/e2b/README.*` (kind `package-group`), paire `docs/subsystems/e2b.md|.zh|.i18n.yaml` (blocs `ts type-equiv` Config + `ts public-api` E2bConnection, entrées dans `scripts/type-equiv.manifest.json`), lignes ajoutées à `packages/README.md` et `docs/subsystems/README.md` (+ .zh), entrée `SERVICE_PAGE` `e2b: 'e2b.md'`, entrée `SENTENCE_MODEL_EXPERIENCE`, `LINK_MAP` (`E2bState`/`E2bStatus`), exemption `Sandbox` (SDK tiers), `GROUP_ORDER` + `SERVICE_ROLES` dans `gen-doc-graphs.ts`. Catalogs régénérés : cordis-catalog, config-catalog, doc-graphs, module-graph, dependency-catalog, plugin-packages, third-party-notices, tsconfig-paths, scoped-events.

### Décisions techniques

1. Seam publique `ctx.e2b` (nouvelle seam lifecycle) plutôt que de cacher le SDK : `fs-e2b` (Phase 4) et `subprocess-e2b` (Phase 6) l'injecteront.
2. Une seule instance par composition, un seul sandbox détenu ; second owner refusé. Sélection par session = preset + isolate (inchangé, Phase 7).
3. Annulation ambiguë assumée : un create interrompu peut abandonner un sandbox distant qui expire avec son `timeoutMs` ; jamais de reconnexion/rejeu (condition de la note de retrait).
4. Fixture de composition : `ModuleLoader.fromInternal()` surchargé par une map de fixtures — pattern stagehand — car la résolution native des `name:` exige `lib/index.js` absent d'un clean tree.

### Tests / vérifications exécutées

- `vitest` paquet : 13/13 ✓ ; coverage 100 % ✓ ; `tsc -b` paquet + typecheck complet (`pnpm run typecheck`) ✓ ; lint complet ✓ ; `git diff --check` ✓.
- `pnpm run test:docs` 20/20 ✓ ; `pnpm run doc-sync` 42/42 ✓ ; `pnpm run hygiene` 18/18 ✓ ; `verify-no-unknown-casts`, `verify-export-jsdoc`, `verify-package-*`, `verify-cordis-config`, `verify-type-equiv`, `verify-subsystem-pages`, `verify-translation-pairing` (1137 paires) ✓.
- `vitest run scripts/` : 4 échecs sur 2183, tous `Test timed out in 5000ms` (`migrate-sessions-to-v4`, `prepare` wheel, `oxlint-contract`), non reproductibles isolément — lenteur/parallélisme de l'environnement, aucun fichier touché par ce lot.

### Problèmes

- Gaps #1–#7 inchangés (Phases 7-8). `live.e2e.ts` non exécuté ici : pas de `E2B_API_KEY` dans l'environnement (auto-skip conçu).
- Choix de design Phase 2 (sélection preset+isolate vs profil entier) toujours à confirmer avant Phase 7.

### Prochaine phase

Phase 4 — `fs-e2b` branché sur `sandbox.files`, injectant `ctx.e2b`.


---

## Phase 4 — FILESYSTEM FS-E2B (livrée)

### Objectif

Fournir `ctx.fs` sur le sandbox E2B : un provider `fs-e2b` qui injecte `ctx.e2b`, ses tests à couverture 100 %, sa documentation et les gates — sans UI ni agent parallèle.

### Livrables

- **Package** : `packages/e2b/fs-e2b` (`@deepseek-ai/dsh-fs-e2b`, v `0.1.7-rc.2`, peer `@deepseek-ai/cordis` / `dsh-e2b` / `dsh-fs`, deps `@deepseek-ai/schemastery` + `e2b@2.51.0`).
- **Provider** : `E2bFileSystem` (`static inject = ['e2b']`) — Config `cwd?` (défaut : workspace de la connexion) et `diffBasisMaxBytes?` (défaut 10 MiB, validé au montage) ; `resolve()` suit les liens symboliques vers une identité unique (limite 40 sauts, cycle = non trouvé), versions = `mtime:size:mode`, mutations sérialisées FIFO par cible, diff basis borné côté texte, conservation des fins de ligne, flux UTF-8 identiques aux autres backends, erreurs SDK traduites en `FsErrorCode`, `FS_ABORTED` sur signal annulé.
- **Déduplication dans `dsh-fs`** : `src/locks.ts` (`TargetLocks` partagé par fs-local et fs-e2b) et `src/diff-basis.ts` (`DEFAULT_DIFF_BASIS_MAX_BYTES`, `MAX_DIFF_BASIS_BYTES`, `assertDiffBasisMaxBytes`) ; `processPath` / `fileUrl` / `contains` rendus concrets dans `FileSystem` (défauts POSIX, doc « default » + override) — overrides supprimés de fs-local (garde son `contains` platform-aware), fs-ssh et fs-e2b → `pnpm run duplication` à 0 clone (les 3 clones du diagnostic initial sont résolus par extraction, pas par `jscpd:ignore`).
- **Tests** : `tests/provider.spec.ts` + `tests/composition.spec.ts` = 79 tests verts, 100 % statements/branches/functions/lines sur `src/index.ts` ; fixture SDK `tests/fixtures/e2b.ts` (hooks d'échec/lecture/stream/symlink, horloge, diff-basis) ; `fs/fs` complété par `tests/locks.spec.ts` et `tests/diff-basis.spec.ts` + un test des défauts d'identité dans `service.spec.ts` (couverture propre du package à 100 %) ; total des 4 paquets : 346 tests.
- **Docs** : paire `packages/e2b/fs-e2b/README.md|.zh.md|.i18n.yaml` (kind `package-reference`, Model Experience « indirect » + Known Limitations + Dev Note), page groupe `packages/e2b/README.*` (table à 2 paquets), section « Filesystem provider » dans `docs/subsystems/e2b.md|.zh` + record, capability-seams régénéré (nœud `pkg_fs_e2b`, arêtes `pkg_fs_e2b --> svc_fs` et `svc_e2b --> pkg_fs_e2b`, providers `ctx.fs` + consumers `ctx.e2b`, miroir zh aligné), rows `packages/README.*` et `docs/subsystems/README.*`, entrée `packages/e2b/fs-e2b` (`indirect`) dans `verify-package-readme-model-experience.ts`, modèle `gen-doc-graphs.ts` (`implementations` fs + `consumers` e2b). Catalogs régénérés : cordis-catalog (signatures concrètes `processPath`/`fileUrl`/`contains` dans `filesystem.md|.zh`), doc-graphs, config-catalog, plugin-packages. Correctif type-equiv : `get workspace` manquant dans le bloc `E2bConnection` de `e2b.md|.zh`.

### Décisions techniques

1. Défauts concrets dans la classe de base plutôt que `jscpd:ignore` : `FileSystem` fournit les identités POSIX ; un backend à clés non-POSIX les surcharge.
2. `TargetLocks` et les bornes de diff basis extraits dans `dsh-fs` : verrous partagés et validation de config sont des obligations du seam, pas d'un backend.
3. Couverture complétée sans hooks de test : post-check d'annulation dans `probe()`, branche morte `take > 0` supprimée de `readWindow`, cas dédiés pour lien sans cible, cycle, limite de sauts, parent fichier, rejet non-Error, flux ≥ 8192 o, abort pendant le diff basis.
4. e2e réel (`E2B_API_KEY`) reporté Phase 9 ; ici fixture SDK + composition Loader réelle (auto-skip conçu).

### Tests / vérifications exécutées

- `vitest` des 4 paquets : 346 tests (343 passants, 3 skippés) ; coverage ciblée 100 % (733/733 stmts, 436/436 branches, 139/139 funcs, 641/641 lines) ; `fs/fs` isolé 100 % (83/83).
- `pnpm run typecheck` 0 erreur (build host + client) ; `lint:contracts-ready` ; `pnpm run duplication` 0 clone ; `verify-export-jsdoc` ; `verify-no-unknown-casts` (1448 inchangé).
- `pnpm run doc-sync` 42/42 ; `pnpm run test:docs` 20/20 ; `pnpm run hygiene` 18/18 ; `verify-type-equiv` 467 blocs ; `verify-translation-pairing` 1137 paires.

### Problèmes

- Gaps #1–#7 inchangés (Phases 5-8).
- Choix de design Phase 2 (sélection preset+isolate vs profil entier) toujours à confirmer avant Phase 7.

### Prochaine phase

Phase 5 — Shell au travers de `subprocess-e2b` (pwd/ls/echo/git) et row `sandbox-policy` distante.

## Phase 5 — SHELL SUBPROCESS-E2B (sandbox-policy distante : livrée ; commande via bash-local : partielle)

### Objectif

Vérifier que `bash-local` fonctionne au travers de `subprocess-e2b` (pwd/ls/echo/git) et adapter la `row sandbox-policy` distante (`workspaceRoot` = chemin dans le sandbox E2B, pas `process.cwd()` hôte).

### Livrables

- **Sandbox-policy distante** (`packages/sandbox/sandbox-policy/src/index.ts`) : le constructeur résout `workspaceRoot` en priorité depuis le sandbox E2B (`ctx.get('e2b')?.workspace`) puis retombe sur le config `workspaceRoot` et enfin sur `process.cwd()` ; aucun `as unknown` ; le getter `e2b` est optionnel (la ligne locale reste intacte). Pas de nouvelle exportation publique ni d'invariant.
- **Bash-local via subprocess-e2b** : le contrat est établi (`bash-local` injecte `['subprocess']` ; `subprocess-e2b` expose `ctx.subprocess` via `ctx.e2b`) ; la vérification interactive (commande `pwd`/`ls`/`echo`/`git` dans le sandbox distant) reste à exécuter en e2e réel (`tests/live.e2e.ts` étendu — non appliqué ici ; le test e2e existant auto-skip en absence de `E2B_API_KEY`).

### Décisions techniques

1. Acquisition sandbox = **synchrone** (`ctx.e2b.sandbox` getter) — même logique que Phase 6.
2. `workspaceRoot` distant résolu par `resolveWorkspaceRoot(e2bWorkspace ?? config.workspaceRoot ?? process.cwd())` ; la ligne locale reste inchangée quand `e2b` est absent.

### Tests / vérifications exécutées

- `pnpm run doc-sync` 42/42 (pas de changement doc nécessaire au-delà de la note AGENT.md) ; `pnpm run lint` 0 erreur (tgolint vert) ; `pnpm run typecheck` 0 erreur ; `git diff --check` ok.
- `verify-module-graph` + `verify-doc-graphs` verts ; `verify-config-catalog` vert.
- Coverage package `subprocess-e2b` inchangée (107/107) ; aucun nouveau test `shell.e2e` ajouté (hors périmètre Phase 5 ici).

### Problèmes

- Vérification commande `pwd`/`ls`/`echo`/`git` via `bash-local` dans le sandbox E2B reste à réaliser (e2e réel, conditionnel `E2B_API_KEY`).

---

## Phase 6 — SUBPROCESS SUBPROCESS-E2B (livrée)

### Objectif

Fournir `ctx.subprocess` sur le sandbox E2B : `spawn` (stream/collect/stop/exit code) et `spawnTerminal` via `sandbox.pty`, injectant `ctx.e2b`, avec tests à couverture 100 %, documentation et gates — sans UI ni agent parallèle.

### Livrables

- **Package** : `packages/e2b/subprocess-e2b` (`@deepseek-ai/dsh-subprocess-e2b`, v `0.1.7-rc.2`, peer `@deepseek-ai/cordis` / `dsh-e2b` / `dsh-subprocess` / `dsh-timeout`, deps `@deepseek-ai/schemastery` + `e2b@2.51.0` ; exports sans `./src/*`, modèle `fs-e2b`).
- **Service** : `E2BSubprocessRuntime` (`static inject = ['e2b']`, Config `pollMs` défaut 20) — `spawn` valide argv/cwd/env/grace de façon synchrone avant tout travail distant puis enregistre le handle ; `spawnTerminal` alloue via `pty.create` ; `resolveExecutable` (`command -v` à la racine du workspace) ; `terminalEnvironment` (`platform: 'posix'` + `defaultShell` si absolu) ; `control = undefined` (le transport E2B ne porte pas le canal fd-7 du confinement PTC, gap #6 assumé).
- **Handles** : `E2BSubprocessHandle` (runner `bash`, publication asynchrone de l'identité de groupe de processus, sorties stream/collect/spill, échelle de terminaison `SIGTERM` → `SIGKILL` + fallback SDK kill, `waitForExit` borné, quiescence prouvée par sonde `ps`, `SandboxNotFoundError` = quiescence) et `E2BTerminalHandle` (`write`/`resize`/`inspectForeground`/`inspectActivity`).
- **Séam étendu** : `SubprocessHandle.control: Duplex | undefined` et `SubprocessTerminalHandle.resize` / `inspectActivity` ajoutés au contrat `dsh-subprocess` (un seul provider local + le remote E2B les implémentent).
- **Limites assumées** : `inspectActivity` renvoie toujours `{ state: 'unknown', revision: 0 }` (E2B n'expose pas de signal d'activité par terminal) → la rétention ne ferme jamais un terminal par inactivité ; `terminalType` est câblé dans l'environnement écrit (`TERM: spec.terminalType` gagne, comme `subprocess-local`).
- **Tests** : `tests/subprocess.spec.ts` + `tests/terminal.spec.ts` = 107 tests verts, 100 % stmts/branches/functions/lines sur `src/**` (912/912, 451/451, 164/164, 803/803) ; fixtures SDK structurelles (`E2bRemoteCommand`, `E2bSandboxOwner`, sous-classe `ObservableSubprocessRuntime` pour observer `live`) ; e2e `tests/live.e2e.ts` (`describe.skipIf(!E2B_API_KEY)` : `resolveExecutable`, commande avec cwd/env/expérience d'isolement de secret, processus long terminé, marqueur `TERM` du terminal, `resize`, `inspectActivity` inconnu) auto-vérifié en mode skip.
- **Docs** : paire README `packages/e2b/subprocess-e2b/README.md|.zh.md` restaurée depuis la génération antérieure au retrait d'E2B (`.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.md`) puis adaptée (limitation « Terminal activity is always unknown » ajoutée des deux côtés), record `README.i18n.yaml` régénéré au format par-section, entrée `SENTENCE_MODEL_EXPERIENCE` (`indirect`), ancre `config-catalog`, nœud `module-graph`, ligne `gen-plugin-packages`, `third-party-notices` (déjà à jour).

### Décisions techniques

1. Acquisition de la sandbox = getter **synchrone** `ctx.e2b.sandbox` (3 sites : start, liveness, terminate) — le hot path de `spawn`/`waitForExit` ne doit jamais attendre une acquisition réseau ; l'annulation de l'acquisition asynchrone ne serait plus observable.
2. Types SDK non exportés redéfinis localement (`E2bRequestOpts`, `E2bWriteEntry`, `E2bPtyCreateOpts`) au lieu d'importer des membres non publics de la surface `e2b`.
3. Aucun `as unknown` (baseline `verify-no-unknown-casts` = 1448 inchangé) ; les casts restants sont des downcasts `Base → Impl` ou des fixtures structurelles typées par `E2bTrackedSubprocess`.
4. Pas de test de composition pour ce package (précédent `subprocess-ssh`, aucun gate ne l'exige).
5. Long processus réel validé par `echo started; sleep 60` + arrêt, plutôt que `npm run dev` (instable et coûteux en e2e).

### Tests / vérifications exécutées

- `vitest` paquet : 107/107 ✓ ; coverage ciblée 100 % ✓ ; `tsc -b tsconfig.host.json` + `pnpm run typecheck` (host + client) 0 erreur ✓ ; `pnpm run lint` 3 passages consécutifs ✓ (les SIGTERM initiaux de `tsgolint` sur exécutions froides n'étaient pas un OOM — `oom_kill=0` — ni reproductibles sous charge ; passes répétés verts).
- `pnpm run doc-sync` 42/42 ✓ (après `gen-config-catalog`, `gen-module-graph`, `gen-plugin-packages`, record de jumelage) ; `pnpm run hygiene` 18/18 ✓ ; `pnpm run duplication` 0 clone ✓ ; `verify-export-jsdoc` ✓ ; `verify-no-unknown-casts` (1448) ✓ ; `verify-third-party-notices` ✓ ; `git diff --check` ✓.
- e2e réel non exécuté ici : absence de `E2B_API_KEY` (auto-skip conçu, vérifié par `vitest --config vitest.e2e.config.ts`).

### Problèmes

- Gaps #1–#6 inchangés (Phases 7-8) ; gap #3 (`sandboxPolicy.workspaceRoot` distant) traité ci-dessous ; le contrôle PTC fd-7 reste indisponible sur E2B (gap #6).
- Choix de design Phase 2 (sélection preset+isolate vs profil entier) toujours à confirmer avant Phase 7.

### Prochaine phase

Phase 5 — Shell au travers de `subprocess-e2b` (pwd/ls/echo/git) : **livrée** (sandbox-policy distante) ; reste vérification commande bash par `subprocess-e2b`.
