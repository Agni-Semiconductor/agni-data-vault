// @ts-nocheck
// VAULT_READONLY=1 is the phase-2 shakedown flag: deploy the whole application against migrated
// data with every write refused, and compare pages against the live site. It is fail-closed by
// design, so the ONE exception carved into it needs its own tests — a fail-closed flag with a
// hole in it reads as protection while admitting exactly what it was added to stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ routed: [] as Array<{ method: string; segments: string[] }> }))
vi.mock('../api/_lib/router.js', () => ({
  route: (req: { method: string }, segments: string[]) => { state.routed.push({ method: req.method, segments }); return { status: 200, body: { ok: true } } },
}))
vi.mock('../api/_lib/auth.js', () => ({ requireAuth: () => ({ kind: 'human', actor: 'owen.ledger@agnisemi.ai' }) }))

const { default: handler } = await import('../api/handler.js')

/** Minimal req/res pair: enough for handler.js, nothing more. */
function call(method: string, path: string) {
  const res: Record<string, unknown> = { headers: {}, statusCode: 0, body: undefined, writableEnded: false }
  Object.assign(res, {
    setHeader: (k: string, v: string) => { (res.headers as Record<string, string>)[k] = v },
    status: (code: number) => { res.statusCode = code; return res },
    json: (payload: unknown) => { res.body = payload; return res },
    end: () => { res.writableEnded = true; return res },
    send: (payload: unknown) => { res.body = payload; return res },
  })
  return handler({ method, url: `/api/${path}`, query: {}, headers: {} }, res).then(() => res)
}

beforeEach(() => { state.routed = []; process.env.VAULT_READONLY = '1' })
afterEach(() => { delete process.env.VAULT_READONLY })

describe('VAULT_READONLY=1', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s on an ordinary path', async (method) => {
    const res = await call(method, 'samples')
    expect(res.statusCode).toBe(503)
    expect((res.body as { error?: { code?: string } })?.error?.code).toBe('read_only')
    expect(state.routed, 'the router must not be reached at all').toEqual([])
  })

  it('still allows GET', async () => {
    const res = await call('GET', 'samples')
    expect(res.statusCode).toBe(200)
    expect(state.routed).toHaveLength(1)
  })

  it('allows POST /api/cohorts/summary, which computes and writes nothing', async () => {
    // Refusing this would make the read-only shakedown unable to exercise cohorts at all — the
    // one thing phase 2 exists to do against real migrated data.
    const res = await call('POST', 'cohorts/summary')
    expect(res.statusCode).toBe(200)
    expect(state.routed).toEqual([{ method: 'POST', segments: ['cohorts', 'summary'] }])
  })

  it('THE HOLE THAT MUST NOT EXIST: POST /api/cohorts is still refused', async () => {
    // A prefix match (`startsWith('cohorts')`) would admit this, and this one CREATES A ROW.
    // The allow-list is exact paths for exactly this reason.
    const res = await call('POST', 'cohorts')
    expect(res.statusCode).toBe(503)
    expect(state.routed).toEqual([])
  })

  it.each([
    ['cohorts/summary/extra', 'a deeper path under the allowed one'],
    ['COHORTS/SUMMARY', 'a case variation — the router is case-sensitive, so this is not the allowed route'],
    ['cohorts/../cohorts/summary', 'a traversal: `..` survives as a segment, so this is not the allowed path'],
  ])('refuses POST /api/%s (%s)', async (path) => {
    const res = await call('POST', path)
    expect(res.statusCode).toBe(503)
  })

  it('a trailing slash is the SAME path, and is allowed — which is the point of matching segments', async () => {
    // `pathSegments` splits and filter(Boolean)s, so 'cohorts/summary/' yields the identical
    // ['cohorts','summary'] and routes to the identical handler. Admitting it is correct: it is
    // not another endpoint. This is also why the allow-list matches NORMALISED SEGMENTS rather
    // than the raw URL — a raw-string comparison would refuse this legitimate request while
    // being bypassable in the other direction by anything the router normalises away.
    const res = await call('POST', 'cohorts/summary/')
    expect(res.statusCode).toBe(200)
    expect(state.routed).toEqual([{ method: 'POST', segments: ['cohorts', 'summary'] }])
  })

  it('the exception is inert when the flag is off — everything routes', async () => {
    delete process.env.VAULT_READONLY
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const res = await call(method, 'samples')
      expect(res.statusCode).toBe(200)
    }
    expect(state.routed).toHaveLength(3)
  })
})
