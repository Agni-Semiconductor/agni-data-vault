// PostgREST client for the `vault` schema on edaserver. supabase-js speaks PostgREST
// natively, so pointing it at a self-hosted PostgREST with a locally minted HS256 JWT
// is indistinguishable from the hosted project -- which is why every file under
// api/_lib/resources/ needs no changes. See docs/CONTRACT.md v2.1.
//
// The export name is deliberately unchanged: six tests/api-*.test.ts files vi.mock this
// module by name, and they are the only safety net on the resource layer.
import { createClient } from '@supabase/supabase-js';
let client = null;
export function supabaseAdmin() { if (!client) { const url = process.env.VAULT_REST_URL; const key = process.env.VAULT_SERVICE_JWT; if (!url || !key) throw new Error('VAULT_REST_URL and VAULT_SERVICE_JWT environment variables must be set'); client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { schema: 'vault' } }); } return client; }
export { supabaseAdmin as vaultDb };
