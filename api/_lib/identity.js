import { verifyAccessJwt } from './accessJwt.js';

// The reverse proxy strips client-supplied Cf-Access-* headers on ingress and vault-api binds
// loopback; this module is nonetheless safe on its own because the signature is VERIFIED
// rather than trusted. That is why we verify instead of trusting a header.
//
// CALLER CONTRACT -- two distinct failure shapes, and requireAuth must handle both:
//   returns null  -> no assertion header at all, or a validly-signed token whose identity
//                    is not permitted here (wrong email domain, missing/mismatched `hd`).
//   THROWS        -> an assertion header was present but the token is bad: malformed,
//                    wrong signature, alg:none, HMAC-signed, expired, or wrong audience.
// Both must become 401. Letting the throw escape uncaught turns a rejected credential
// into a 500, which reads as "the server is broken" instead of "your token is not valid".
export async function identityFrom(req) { const token = req.headers?.['cf-access-jwt-assertion']; if (typeof token !== 'string' || !token) return null; const payload = await verifyAccessJwt(token); const domain = process.env.VAULT_EMAIL_DOMAIN; const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''; if (!domain || !email || !payload.hd || payload.hd !== domain || email.split('@').length !== 2 || email.split('@')[1] !== domain) return null; return { email, kind: 'human' }; }
