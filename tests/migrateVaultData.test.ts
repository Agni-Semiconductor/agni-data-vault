// This migration is a one-time operation over the only hosted copy. These checks pin its safety
// boundaries before an operator supplies credentials, because a successful-looking partial copy is
// more dangerous than an early failure that leaves the source untouched.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const scriptPath = resolve(root, 'scripts/migrate-vault-data.mjs')

/** Removes line comments so documentation of a forbidden form does not produce a misleading CI failure. */
export function executableText(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '')
}

/** Source REST and storage calls must not carry a destructive method, or the only copy can be lost. */
export function sourceMutationRequests(text: string): string[] {
  const sourceCall = /(?:request|fetch)\(\s*(?:(?:restUrl|objectUrl)\(\s*process\.env\.SOURCE_(?:REST|STORAGE)_URL[\s\S]*?\)|process\.env\.SOURCE_(?:REST|STORAGE)_URL)\s*,\s*\{[\s\S]*?\bmethod\s*:\s*['"](?:DELETE|PATCH)['"]/g
  return executableText(text).match(sourceCall) ?? []
}

/** Offset and range paging shift beneath inserts, falsely reporting a complete migration with rows skipped. */
export function offsetPagingCalls(text: string): string[] {
  return executableText(text).match(/\boffset\b|\.range\s*\(/g) ?? []
}

/** A row must not be inserted before its blob, or consumers see a dangling object reference as corruption. */
export function objectsPrecedeRows(text: string): boolean {
  const source = executableText(text)
  const objects = source.indexOf('await migrateObjects(')
  const rows = source.indexOf('await migrateTable(')
  return objects !== -1 && rows !== -1 && objects < rows
}

/** Length can agree after truncation and resume, so it cannot stand in for the content hash. */
export function sizeIntegrityComparisons(text: string): string[] {
  return executableText(text).match(/\b(?:size|byteLength|content-length)\b\s*(?:===|!==|==|!=|<=|>=|<|>)/gi) ?? []
}

describe('migrate-vault-data safety contract', () => {
  it('found a substantive migration script to inspect', () => {
    // An absent or stubbed script makes every content check below a vacuous green, disguising an
    // unreviewed migration as a safe one.
    expect(existsSync(scriptPath), 'scripts/migrate-vault-data.mjs must exist').toBe(true)
    expect(readFileSync(scriptPath, 'utf8').length, 'migration script must exceed 150 characters').toBeGreaterThan(150)
  })

  it('the source-mutation detector catches DELETE against a source endpoint', () => {
    const bad = "await fetch(process.env.SOURCE_REST_URL, { method: 'DELETE' })"
    expect(sourceMutationRequests(bad), 'the detector must reject a source DELETE').toHaveLength(1)
  })

  it('never sends DELETE or PATCH to either source endpoint', () => {
    const offenders = sourceMutationRequests(readFileSync(scriptPath, 'utf8'))
    expect(offenders, 'a source mutation can destroy the system of record while the destination appears migrated').toEqual([])
  })

  it('the offset-paging detector catches an offset paging call', () => {
    const bad = "await client.from('files').select('*').range(100, 199); const offset = 100"
    expect(offsetPagingCalls(bad), 'the detector must reject both offset pagination forms').toEqual(['.range(', 'offset'])
  })

  it('uses an id=gt. keyset cursor and no offset or range pagination', () => {
    const source = readFileSync(scriptPath, 'utf8')
    expect(source, 'keyset paging must use a greater-than cursor, not an unstable row position').toMatch(/\bgt\.\$\{last\}/)
    expect(offsetPagingCalls(source), 'offset pagination silently skips rows when inserts shift later pages').toEqual([])
  })

  it('copies blobs before inserting rows', () => {
    const source = readFileSync(scriptPath, 'utf8')
    expect(objectsPrecedeRows(source), 'rows first leave dangling object references that consumers treat as corruption').toBe(true)
  })

  it('rejects rows-before-blobs ordering', () => {
    const bad = 'await migrateTable(table, rows)\nawait migrateObjects(files)'
    expect(objectsPrecedeRows(bad), 'the ordering detector must reject a dangling-reference migration').toBe(false)
  })

  it('verifies object bytes with sha256 rather than a size comparison', () => {
    const source = readFileSync(scriptPath, 'utf8')
    expect(source, 'sha256 catches equal-length truncation that a byte count reports as valid').toMatch(/\bsha256\b/i)
    expect(sizeIntegrityComparisons(source), 'a size comparison cannot prove the destination bytes match the source').toEqual([])
  })

  it('offers --dry-run and documents it as the first step', () => {
    const source = readFileSync(scriptPath, 'utf8')
    // The help text must make the safe invocation explicit; otherwise an operator can mistake
    // --apply for the exploratory command and write before inspecting the planned work.
    expect(source, '--dry-run must be accepted by the command-line parser').toMatch(/['"]--dry-run['"]/)
    expect(source, 'help must say that --dry-run is the default first step').toMatch(/--dry-run is the default/i)
  })
})
