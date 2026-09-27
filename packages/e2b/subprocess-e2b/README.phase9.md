# Phase 9 — End-to-end E2B scenario
# (Refer to AGENT.md Phase 9 ; not a shipped package — scenario documentation)

## Composants livrés (préalables Phase 9)

- Phase 3 : `e2b` (sandbox lifecycle) — livré, tests 13/13 ✓
- Phase 4 : `fs-e2b` — livré, tests 100 % ✓
- Phase 5 : `sandbox-policy` distant (`workspaceRoot` E2B-aware) — livré, poussé ✓
- Phase 6 : `subprocess-e2b` (commands + terminal) — livré, 107/107 tests ✓, live.e2e.ts PASSÉ (clè `e2b_9d5692b...`)
- Phase 7 : preset `e2b` (`packages/bundle/web-app/presets/e2b.patch.yml`) + `mkdir` conditionnel (`agent.ts`) — livré, poussé ✓
- Phase 8 : `WorkspaceFiles` gap #1 (`packages/api/workspace-files/src/index.ts`: `resolveFs()` + doc) — approche établie, poussé ✓

## Scénario end-to-end (à exécuter manuellement ou via CI avec `E2B_API_KEY`)

1. Sélection preset : `agent-preset/select` → `e2b` (`packages/bundle/web-app/presets/e2b.patch.yml`).
2. Sandbox : `e2b.create()` → `initWorkspace()` (workspace distant `/home/user/workspace-dsh-subprocess-e2e`).
3. Projet : `mkdir` conditionnel (hôte : non créé si E2B ; distant : géré par `initWorkspace`).
4. Terminal : `subprocess.spawnTerminal()` → `bash` dans sandbox distant (`TERM` câblé).
5. Build : `subprocess.spawn()` → `npm run build` (ou équivalent) dans `cwd: workspace`.
6. Tests : `subprocess.spawn()` → `npm test` dans workspace.
7. Serveur dev : processus long (`echo started; sleep`) testé dans `live.e2e.ts` (poll + terminate).
8. Git status : `subprocess.spawn({ argv: ['git', 'status'], cwd: workspace })`.
9. Destruction : `e2b.destroy()` (dispose local sans kill réseau ; sandbox expire via `timeoutMs`).

## Vérification existante

`packages/e2b/subprocess-e2b/tests/live.e2e.ts` couvre :
- `resolveExecutable('bash')` (+ `terminalEnvironment`)
- Commande `printf` avec `cwd: workspace`, `env`, `graceMs`
- Processus long (`echo started; sleep 60`) + `poll()` + `terminate()` + `waitForExit()`
- Terminal (`bash --noprofile --norc`) + `write()` (`printf`) + `inspectActivity()` (`unknown`) + `resize()` + `terminate()`
- Auto-skip sans `E2B_API_KEY`

## Prochain jalon (hors Phase 9 — Phase 10 Nettoyage)

- Intégrer le preset `e2b` dans le bundle de base (ou documenter l'utilisation `--patch` / `cordis.yml` utilisateur).
- Corriger le full `WorkspaceFiles` pour lire `agent.ctx.fs` au lieu de `ctx.fs` (Phase 8, gap #1 final).
- Nettoyer doublons (`fs-e2b` / `subprocess-e2b` vs `fs-ssh` / `subprocess-ssh`), code expérimental (`packages/experimental/`).
