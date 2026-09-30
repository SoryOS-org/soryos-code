/**
 * @deepseek-ai/dsh-codespaces — the Codespaces bundle: the environment services
 * patch layer over dsh-base plus the isolated agent preset mounting the SSH
 * remote provider family. The bundle carries no runtime glue plugin; the
 * connection lifecycle is owned by `ctx.codespacesConnection` and the remote
 * providers are mounted inside the preset's isolated realm.
 * @module @deepseek-ai/dsh-codespaces
 */

export const name = 'codespaces-bundle'
