import http from 'node:http';
import { randomUUID } from 'node:crypto';
import handler from '../api/handler.js';
import { health } from '../api/_lib/health.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 8099);
const maxJsonBytes = 10 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let sizeBytes = 0;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAborted); req.off('error', onError); };
    const finish = (result) => { cleanup(); resolve(result); };
    const onData = (chunk) => { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); sizeBytes += buffer.length; if (sizeBytes > maxJsonBytes) { cleanup(); req.resume(); resolve({ tooLarge: true }); return; } chunks.push(buffer); };
    const onEnd = () => finish({ buffer: Buffer.concat(chunks, sizeBytes) });
    const onAborted = () => finish({ aborted: true });
    const onError = (error) => { cleanup(); reject(error); };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });
}

async function serve(req, res) {
  const startedAt = process.hrtime.bigint();
  const requestId = randomUUID();
  const method = req.method || 'UNKNOWN';
  let path = (req.url || '/').split('?')[0];
  let logged = false;
  let aborted = false;
  const logRequest = () => { if (logged) return; logged = true; const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6); console.log(`${method} ${path} ${res.statusCode} ${durationMs}ms ${requestId}`); };
  res.once('finish', logRequest);
  res.once('close', logRequest);
  req.once('aborted', () => { aborted = true; if (!res.headersSent) res.statusCode = 499; if (!res.writableEnded) res.end(); });
  const nativeEnd = res.end.bind(res);
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (object) => { res.setHeader('content-type', 'application/json'); nativeEnd(JSON.stringify(object)); };
  req.requestId = requestId;

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    path = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    query.route = url.pathname.replace(/^\/api\/?/, '');
    req.query = query;

    // Handled here, ahead of handler(), because api/handler.js applies requireAuth before it
    // routes: sending /healthz through it would answer 401 to every monitor.
    if (url.pathname === '/healthz' || url.pathname === '/api/healthz') {
      if (method.toUpperCase() !== 'GET') { res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET' } }); return; }
      const result = await health();
      res.status(result.ok ? 200 : 503).json(result);
      return;
    }

    const isContentUpload = method.toUpperCase() === 'PUT' && /^\/api\/files\/[^/]+\/content\/?$/.test(url.pathname);
    if (isContentUpload) {
      req.rawStream = req;
    } else {
      const contentTypeHeader = req.headers['content-type'];
      const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType === 'application/json') {
        const contentLength = Number(req.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxJsonBytes) {
          req.resume();
          res.status(413).json({ error: { code: 'payload_too_large', message: 'JSON body exceeds 10 MB' } });
          return;
        }
        const result = await readJsonBody(req);
        if (result.aborted || aborted) return;
        if (result.tooLarge) {
          res.status(413).json({ error: { code: 'payload_too_large', message: 'JSON body exceeds 10 MB' } });
          return;
        }
        if (result.buffer.length) { try { req.body = JSON.parse(result.buffer.toString('utf8')); } catch { req.body = {}; } }
      }
    }

    if (!aborted) await handler(req, res);
  } catch (error) {
    if (aborted || req.aborted) return;
    console.error(`Unhandled vault API error requestId=${requestId}:`, error);
    if (!res.headersSent) res.status(500).json({ error: { code: 'internal', message: error?.message || 'Internal error' } });
    else if (!res.writableEnded) res.end();
  }
}

// FAIL BEFORE LISTENING, not on the first request.
//
// These are read lazily inside supabaseAdmin(), which throws when something first tries to use it.
// Without this check the process starts cleanly, systemd reports `active`, a port monitor sees a
// listener, and every request returns 500 with a message about the environment -- so the service
// looks up and behaves broken, which is the hardest combination to diagnose and the one a health
// check is least likely to distinguish from a database problem.
//
// Exit 1 rather than throwing: systemd then shows the unit as failed with the reason in the
// journal, which is what an operator looks at, instead of a running unit and a confusing log line.
const REQUIRED = ['VAULT_REST_URL', 'VAULT_SERVICE_JWT'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `Agni Vault API refusing to start: ${missing.join(', ')} not set. ` +
      'These are read from EnvironmentFile=/etc/vault/vault-api.env by the systemd unit; ' +
      'a service that starts without them answers every request with a 500 while appearing healthy.',
  );
  process.exit(1);
}

const server = http.createServer((req, res) => { void serve(req, res); });
server.listen(port, host, () => console.log(`Agni Vault API listening on http://${host}:${port}`));
