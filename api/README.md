api/handler.js is the single Vercel serverless function entry for all API routes (see docs/CONTRACT.md section 7); the vercel.json rewrite maps /api/:path* to it with ?route=:path*.
Shared helpers live in api/_lib/ and resource modules in api/_lib/resources/.
The api/ directory is plain JavaScript ESM (Node 20+), not TypeScript — it is excluded from tsc and eslint.
Syntax gate before committing: `node --check api/handler.js` (and the same for each file under api/_lib/).
