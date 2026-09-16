/* eslint-disable @typescript-eslint/no-explicit-any */
// The browser client no longer touches the database. It is a fetch wrapper over /api, so this
// file tests the wire: the URL and query string it builds, that it sends the session cookie,
// and that it unwraps the contract's error envelope.
//
// The filename-helper tests that used to live here moved to tests/api-storage.test.ts, against
// the server's parseFilename and kindFromExtension. Their browser twins are gone: they had
// drifted (Unicode vs ASCII cleaning), so the same file landed at a different storage path
// depending on which client uploaded it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getFileUrl, getStats, listSamples, updateSample } from '../src/lib/api'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const empty = { items: [], total: 0 }
let calls: Array<[string, RequestInit]>

function stub(response: () => Response) {
  calls = []
  const fetchMock = vi.fn(async (url: any, init: any) => { calls.push([String(url), init ?? {}]); return response() })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => { calls = [] })
afterEach(() => vi.unstubAllGlobals())

describe('api client transport', () => {
  it('calls /api and sends credentials so the Access session cookie rides along', async () => {
    stub(() => json(empty))
    await listSamples()
    expect(calls[0][0]).toContain('/api/samples')
    expect(calls[0][1].credentials).toBe('include')
  })

  it('unwraps the contract error envelope into an Error carrying the code', async () => {
    stub(() => json({ error: { code: 'validation_failed', message: 'kind is required', details: [{ key: 'kind', message: 'required' }] } }, 422))
    await expect(listSamples()).rejects.toMatchObject({ code: 'validation_failed', message: 'kind is required' })
  })

  it('falls back to a status message when the body is not the envelope', async () => {
    stub(() => new Response('gateway blew up', { status: 502 }))
    await expect(listSamples()).rejects.toMatchObject({ code: 'request_failed' })
  })
})

describe('api client query building', () => {
  it('passes a search term and paging through as query params', async () => {
    stub(() => json(empty))
    await listSamples({ q: 'HfN', limit: 25, offset: 50 })
    const url = calls[0][0]
    expect(url).toContain('q=HfN')
    expect(url).toContain('limit=25')
    expect(url).toContain('offset=50')
  })

  it('sorts by the real column when a field definition names one', async () => {
    stub(() => json(empty))
    await listSamples({ sort: { key: 'temperature_c', desc: true }, defs: [{ key: 'temperature_c', type: 'number', column_name: 'temperature_c' } as any] })
    expect(calls[0][0]).toContain('sort=temperature_c')
    expect(calls[0][0]).toContain('order=desc')
  })

  // These two moved SERVER-side. The browser used to fetch and then filter numeric meta ranges
  // itself, which silently ignored the database's pagination limit and so returned the wrong
  // page. The client must now hand the filter to the API and not post-process the rows.
  it('sends numeric meta ranges to the server rather than filtering locally', async () => {
    stub(() => json({ items: [{ meta: { temp: 5 } }, { meta: { temp: 15 } }], total: 2 }))
    const result = await listSamples({ filters: { temp: { min: 10 } }, defs: [{ key: 'temp', type: 'number', column_name: null } as any] })
    expect(calls[0][0]).toMatch(/meta\.temp\.min=10|temp\.min=10/)
    // Whatever the server returned is what we return: no local filtering.
    expect(result.items).toHaveLength(2)
  })

  it('sends multi-value filters to the server', async () => {
    stub(() => json(empty))
    await listSamples({ filters: { owner: ['a', 'b'] }, defs: [{ key: 'owner', type: 'select', column_name: null } as any] })
    expect(calls[0][0]).toMatch(/owner/)
  })
})

describe('api client file access', () => {
  it('getFileUrl is a plain content URL with no round trip', async () => {
    const fetchMock = stub(() => json({}))
    const url = await getFileUrl({ id: 'f-1' } as any)
    expect(url).toBe('/api/files/f-1/content')
    // The point of the change: the session cookie authorises <img src> and <a href> directly,
    // so this no longer costs a request to mint a signed URL.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('api client writes', () => {
  it('PATCHes a sample and forwards expected_updated_at for optimistic concurrency', async () => {
    stub(() => json({ sample: { id: 's-1' } }))
    await updateSample('s-1', { columns: { label: 'x' }, meta: {}, meta_status: {} }, '2026-01-01T00:00:00Z')
    expect(calls[0][1].method).toBe('PATCH')
    expect(String(calls[0][1].body)).toContain('expected_updated_at')
  })

  it('getStats is one request, not six', async () => {
    const fetchMock = stub(() => json({ samples: 1, measurements: 2, files: 3, bytes: 4, by_kind: {}, recent: [] }))
    const stats = await getStats()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(stats.samples).toBe(1)
  })
})
