// A figure learns each source's filename from the SAME response that carries its bytes, because
// there is no GET /api/files/:id route and adding one just to read a name would be a contract
// change for something the router already sends. That makes this parser load-bearing:
// `detectKind` reads the name it returns, and the wrong name picks the wrong axes — a board
// capture read as a plain DC-IV export plots `AV`/`AI` columns that are not there.
import { describe, expect, it } from 'vitest'
import { filenameFrom } from '../src/lib/contentDisposition'

describe('filenameFrom', () => {
  it('reads the RFC 5987 form the router actually emits', () => {
    // api/_lib/router.js builds exactly this: `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    expect(filenameFrom("attachment; filename*=UTF-8''20-DC-1.xlsx")).toBe('20-DC-1.xlsx')
  })

  it('percent-decodes, since the router encodeURIComponent()s the name', () => {
    // Real corpus paths carry spaces and '#': "Dhiren Site@1 Subsite capacitor DC-IV#1 Run4482".
    // Left encoded, `detectKind`'s /dc-iv/ test still matches here by luck — but a name shown to
    // a user as "Site%401%20Subsite" is the kind of thing that gets called a bug.
    expect(filenameFrom("attachment; filename*=UTF-8''cap_camp_r000c002_dciv.csv")).toBe('cap_camp_r000c002_dciv.csv')
    expect(filenameFrom("attachment; filename*=UTF-8''Site%401%20Subsite%20DC-IV%231.xlsx")).toBe('Site@1 Subsite DC-IV#1.xlsx')
  })

  it('falls back to the plain form, quoted or not', () => {
    expect(filenameFrom('attachment; filename="20-DC-1.xlsx"')).toBe('20-DC-1.xlsx')
    expect(filenameFrom('attachment; filename=20-DC-1.xlsx')).toBe('20-DC-1.xlsx')
  })

  it('prefers the encoded form when a header carries both', () => {
    // Servers send both for old-browser compatibility, and the plain one is the LOSSY copy —
    // it is the one that has had its non-ASCII characters mangled.
    expect(filenameFrom('attachment; filename="DC-IV_1.xlsx"; filename*=UTF-8\'\'DC-IV%231.xlsx')).toBe('DC-IV#1.xlsx')
  })

  it('returns undefined rather than a guess when there is nothing to read', () => {
    // The caller falls back to the file id, which detectKind will classify as `other`. A wrong
    // guess would be worse: it would pick a kind, and therefore axes, with no basis.
    expect(filenameFrom(null)).toBeUndefined()
    expect(filenameFrom('')).toBeUndefined()
    expect(filenameFrom('attachment')).toBeUndefined()
    expect(filenameFrom('inline')).toBeUndefined()
  })

  it('survives a malformed percent escape instead of throwing', () => {
    // decodeURIComponent throws on a lone '%'. Throwing here would take down the whole figure
    // over a filename, so the raw value is returned and the plot still draws.
    expect(filenameFrom("attachment; filename*=UTF-8''bad%name.xlsx")).toBe('bad%name.xlsx')
  })

  it('stops at the parameter separator', () => {
    expect(filenameFrom("attachment; filename*=UTF-8''a.xlsx; size=12")).toBe('a.xlsx')
  })
})
