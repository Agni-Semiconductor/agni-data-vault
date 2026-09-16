/**
 * Storage for the OAuth server: what it needs to remember, and nothing about how.
 *
 * Two implementations of one small interface. `pgStore` is the real one, over PostgREST through the
 * same `supabaseAdmin` client every resource module uses (schema `vault`, role vault_service).
 * `memoryStore` is for tests and for reasoning: the whole state of the authorization server fits in
 * three Maps, and a test that reads them is a test of what actually happened.
 *
 * Every method takes and returns plain objects with snake_case keys matching the columns in
 * migration 0119, so the two stores cannot drift in shape.
 */
import { supabaseAdmin } from '../../api/_lib/supabaseAdmin.js'

function fail(error, what) {
  const e = new Error(`oauth store: ${what}: ${error.message || String(error)}`)
  e.cause = error
  throw e
}

export function pgStore() {
  const db = () => supabaseAdmin()
  return {
    async getClient(clientId) {
      const { data, error } = await db().from('oauth_clients').select('*').eq('client_id', clientId).maybeSingle()
      if (error) fail(error, 'getClient')
      return data || null
    },
    async putClient(row) {
      const { error } = await db().from('oauth_clients').insert(row)
      if (error) fail(error, 'putClient')
    },
    async touchClient(clientId, at) {
      const { error } = await db().from('oauth_clients').update({ last_used_at: at }).eq('client_id', clientId)
      if (error) fail(error, 'touchClient')
    },
    async putGrant(row) {
      const { data, error } = await db().from('oauth_grants').insert(row).select('id').single()
      if (error) fail(error, 'putGrant')
      return data.id
    },
    async getGrant(id) {
      const { data, error } = await db().from('oauth_grants').select('*').eq('id', id).maybeSingle()
      if (error) fail(error, 'getGrant')
      return data || null
    },
    async getGrantByCodeHash(codeHash) {
      const { data, error } = await db().from('oauth_grants').select('*').eq('code_hash', codeHash).maybeSingle()
      if (error) fail(error, 'getGrantByCodeHash')
      return data || null
    },
    async updateGrant(id, patch) {
      const { error } = await db().from('oauth_grants').update(patch).eq('id', id)
      if (error) fail(error, 'updateGrant')
    },
    async putToken(row) {
      const { error } = await db().from('oauth_tokens').insert(row)
      if (error) fail(error, 'putToken')
    },
    async getToken(tokenHash) {
      const { data, error } = await db().from('oauth_tokens').select('*').eq('token_hash', tokenHash).maybeSingle()
      if (error) fail(error, 'getToken')
      return data || null
    },
    async updateToken(tokenHash, patch) {
      const { error } = await db().from('oauth_tokens').update(patch).eq('token_hash', tokenHash)
      if (error) fail(error, 'updateToken')
    },
    async revokeChain(parentHash, at) {
      // Every token descended from a replayed refresh token. One level is enough in practice because
      // rotation replaces the parent each time, but a loop is cheap and the property is worth having.
      let hash = parentHash
      for (let i = 0; i < 50 && hash; i++) {
        const { data, error } = await db().from('oauth_tokens').select('token_hash').eq('parent_hash', hash)
        if (error) fail(error, 'revokeChain')
        const { error: e2 } = await db().from('oauth_tokens').update({ revoked_at: at }).eq('parent_hash', hash)
        if (e2) fail(e2, 'revokeChain')
        hash = data?.[0]?.token_hash || null
      }
    },
    async ensurePerson(email) {
      // The auto-provisioning v2.3 described: a verified Workspace account becomes a `member`. An
      // existing row, including an admin, is left exactly as it is.
      const { error } = await db().from('people').upsert({ email, role: 'member' }, { onConflict: 'email', ignoreDuplicates: true })
      if (error) fail(error, 'ensurePerson')
    },
  }
}

export function memoryStore() {
  const clients = new Map()
  const grants = new Map()
  const tokens = new Map()
  const people = new Map()
  let seq = 0
  return {
    clients, grants, tokens, people,
    async getClient(id) { return clients.get(id) || null },
    async putClient(row) { clients.set(row.client_id, { ...row }) },
    async touchClient(id, at) { const c = clients.get(id); if (c) c.last_used_at = at },
    async putGrant(row) { const id = row.id || `grant-${++seq}`; grants.set(id, { id, ...row }); return id },
    async getGrant(id) { return grants.get(id) || null },
    async getGrantByCodeHash(h) { for (const g of grants.values()) if (g.code_hash === h) return g; return null },
    async updateGrant(id, patch) { Object.assign(grants.get(id), patch) },
    async putToken(row) { tokens.set(row.token_hash, { ...row }) },
    async getToken(h) { return tokens.get(h) || null },
    async updateToken(h, patch) { Object.assign(tokens.get(h), patch) },
    async revokeChain(parentHash, at) {
      let hash = parentHash
      for (let i = 0; i < 50 && hash; i++) {
        let next = null
        for (const t of tokens.values()) if (t.parent_hash === hash) { t.revoked_at = at; next = t.token_hash }
        hash = next
      }
    },
    async ensurePerson(email) { if (!people.has(email.toLowerCase())) people.set(email.toLowerCase(), { email, role: 'member' }) },
  }
}
