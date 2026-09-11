import { Readable } from 'node:stream'; import { requireAuth } from './_lib/auth.js'; import { route } from './_lib/router.js'; import { ApiError, sendJson, sendError } from './_lib/respond.js';
// POST paths that write NOTHING and must survive VAULT_READONLY=1.
//
// The flag exists so phase 2 can run the whole application against migrated data with every
// write refused. An ANALYSIS call is not a write -- it carries a predicate in its body because a
// structured predicate does not belong in a query string, not because it changes anything -- and
// refusing it would make the read-only shakedown unable to exercise the feature it is there to
// shake down.
//
// EXACT PATHS, never a prefix. `startsWith('cohorts')` would also admit
// POST /api/cohorts, which creates a row, and a fail-closed flag with a prefix hole in it is
// worse than no flag: it reads as protection while admitting the one verb it was added to stop.
// Anything added here needs the same argument made for it in a review, not in passing.
const READONLY_SAFE_POST = new Set([
  'cohorts/summary',
  'cohorts/correlation',
  // The search agent computes a filter and writes only its own audit row. Refusing it under the
  // read-only flag would leave phase 2 unable to exercise the feature against real schema, which
  // is the one thing a shakedown deploy is for. `search/<id>/accepted` is NOT here: it updates a
  // row, and the exactness of this list is the whole reason it is safe.
  'search/ask',
]);
function pathSegments(req) { const q=req.query?.route; if(Array.isArray(q))return q.filter(Boolean); if(typeof q==='string'&&q)return q.split('/').filter(Boolean).map(decodeURIComponent); const p=(req.url||'').split('?')[0].replace(/^\/api\/?/,''); return !p||p==='handler'?[]:p.split('/').filter(Boolean).map(decodeURIComponent); }
export default async function handler(req,res) { const origin=process.env.VAULT_CORS_ORIGIN; if(origin)res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Access-Control-Allow-Credentials','true'); res.setHeader('Access-Control-Allow-Headers','authorization, content-type, Cf-Access-Jwt-Assertion'); res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS'); if(req.method?.toUpperCase()==='OPTIONS'){res.status(204).end();return;} const principal=await requireAuth(req,res); if(!principal)return; if(process.env.VAULT_READONLY==='1'&&['POST','PUT','PATCH','DELETE'].includes(req.method?.toUpperCase())&&!(req.method?.toUpperCase()==='POST'&&READONLY_SAFE_POST.has(pathSegments(req).join('/')))){sendError(res,503,'read_only','The vault is currently read-only');return;} try { const result=await route(req,pathSegments(req),principal); if(result.stream){res.status(result.status); for(const [key,value] of Object.entries(result.headers||{}))res.setHeader(key,value); const source=Readable.fromWeb(result.stream); source.on('error',(err)=>{console.error('API stream error:',err); if(!res.writableEnded)res.destroy(err);}); source.pipe(res); return;} sendJson(res,result.status,result.body); } catch(err) { if(err instanceof ApiError)sendError(res,err.status,err.code,err.message,err.details); else { console.error('Unhandled API error:',err); sendError(res,500,'internal',err.message||'Internal error'); } } }
