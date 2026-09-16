/**
 * One OAuth server per process, built from the environment on first use.
 *
 * Kept apart from server.mjs so the pure server (store + config + fetch + clock in, responses out)
 * stays testable with a memory store, while this file is the only place that knows about env vars
 * and PostgREST. Tests replace it wholesale with `configureOAuthRuntime`.
 */
import { createOAuthServer, isConfigured, oauthConfigFromEnv } from './server.mjs'
import { pgStore } from './store.mjs'

let runtime = null

export function oauthRuntime() {
  if (runtime) return runtime
  const config = oauthConfigFromEnv()
  const configured = isConfigured(config)
  runtime = {
    configured,
    config,
    // Built even when not configured so authenticateBearer() is always callable; with no rows it
    // simply finds nothing. The store is only touched on a `vlt_` bearer.
    server: createOAuthServer({ store: pgStore(), config }),
  }
  return runtime
}

/** Tests only: install a runtime built from a memory store, or reset to env-derived with no args. */
export function configureOAuthRuntime(next = null) {
  runtime = next
}
