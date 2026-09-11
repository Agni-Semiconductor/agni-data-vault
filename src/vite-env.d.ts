/// <reference types="vite/client" />

// ONE entry, and that is the rule rather than the current state.
//
// Vite inlines every `VITE_`-prefixed variable into the bundle at build time, literally, in a file
// served to anyone who can load the page. Contract v2 therefore says "nothing AT ALL starts with
// `VITE_`" rather than "nothing secret does" -- the second version needs every future author to
// classify their own variable correctly, and the first can be checked.
//
// This file declared `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` until the client-secrets
// test found them. They were type-only residue from the browser Supabase client that the
// edaserver repoint deleted, so nothing was being inlined -- but a declaration is an invitation,
// and the next person to want a browser-side credential would have found the type already there
// saying it was fine.
//
// `VITE_API_BASE_URL` is a PATH, not a secret: it is empty in production (same-origin through
// Cloudflare) and points at the dev server locally.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
