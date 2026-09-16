// `connect` is the only database surface promised to agni-connect. These checks pin its view
// names and exclusions to the migration, so an implementation refactor cannot silently become a
// product-contract change.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationPath = resolve(process.cwd(), 'supabase/migrations/selfhost/0118_connect_interface.sql')

if (!existsSync(migrationPath)) {
  throw new Error(`migration not found: ${migrationPath} — a missing contract source must fail rather than make this suite appear to check it`)
}

const migration = readFileSync(migrationPath, 'utf8')
const sql = migration.replace(/--[^\r\n]*/g, '')
const expectedViews = ['bench_runs', 'files', 'health', 'kinds', 'measurements', 'metrics', 'samples']
const forbiddenNames = ['notes', 'created_by', 'updated_by', 'people', 'allowlist', 'audit_log', 'agent_queries']

type ConnectView = { name: string; body: string }

function connectViews(text: string): ConnectView[] {
  const views: ConnectView[] = []
  for (const match of text.matchAll(/create\s+or\s+replace\s+view\s+connect\.([a-z_]+)\s+as\s+([\s\S]*?);/gi)) {
    views.push({ name: match[1].toLowerCase(), body: match[2] })
  }
  return views
}

function projectionNames(body: string): string[] {
  const select = body.match(/^\s*select\s+([\s\S]*)$/i)
  if (!select) return []

  // Split only the outer SELECT list: health has nested SELECTs whose `from` must not end it.
  const columns: string[] = []
  let depth = 0
  let start = 0
  const list = select[1]
  for (let index = 0; index <= list.length; index++) {
    const char = list[index]
    if (char === '(') depth++
    if (char === ')') depth--
    const atOuterFrom = depth === 0 && /^\s*from\b/i.test(list.slice(index))
    if ((char === ',' && depth === 0) || atOuterFrom || index === list.length) {
      const column = list.slice(start, index).trim()
      if (column) columns.push(column)
      if (atOuterFrom || index === list.length) break
      start = index + 1
    }
  }

  return columns.map((column) => {
    const alias = column.match(/\s+as\s+([a-z_][a-z_0-9]*)\s*$/i)
    return (alias?.[1] ?? column.match(/(?:[a-z_][a-z_0-9]*\.)?([a-z_][a-z_0-9]*)\s*$/i)?.[1] ?? '').toLowerCase()
  })
}

function forbiddenNamesInConnectViews(text: string): string[] {
  const found = new Set<string>()
  for (const view of connectViews(text)) {
    for (const name of projectionNames(view.body)) {
      if (forbiddenNames.includes(name)) found.add(name)
    }
    for (const name of forbiddenNames.slice(3)) {
      if (new RegExp(`\\b(?:from|join)\\s+(?:[a-z_][a-z_0-9]*\\.)?${name}\\b`, 'i').test(view.body)) found.add(name)
    }
  }
  return [...found].sort()
}

describe('connect interface contract', () => {
  it('contains SQL statements to inspect', () => {
    // Without this guard, an unreadable or empty migration gives every parser an empty array and
    // a misleading green result that reads as a preserved contract rather than no contract check.
    expect(sql.split(';').filter((statement) => statement.trim()).length).toBeGreaterThan(0)
  })

  it('creates exactly the seven views promised to agni-connect', () => {
    expect(connectViews(sql).map((view) => view.name).sort()).toEqual(expectedViews)
  })

  it('creates connect_read NOLOGIN without BYPASSRLS', () => {
    expect(sql).toMatch(/create\s+role\s+connect_read\s+nologin\b/i)
    // This is correct, not an omitted privilege: security_invoker is OFF for these views, so they
    // execute as their owner. Giving connect_read BYPASSRLS would widen its blast radius and make
    // a mistaken base-table grant expose rows rather than fail as an empty result.
    expect(sql).not.toMatch(/(?:create|alter)\s+role\s+connect_read\b[^;]*\bbypassrls\b/i)
  })

  it('exposes none of the operator text or identity names', () => {
    // `k.notes as description` is intentional: the source registry calls it notes, but exposing
    // that output name would make readers conclude operator free text travels in this interface.
    expect(forbiddenNamesInConnectViews(sql)).toEqual([])
  })

  it('catches a forbidden selected name', () => {
    // Keep a known-bad input here. If the matcher is narrowed until this passes, the preceding
    // exclusion test becomes a misleading green check over names it can no longer detect.
    const unsafe = 'create or replace view connect.files as select f.notes from vault.files f;'
    expect(forbiddenNamesInConnectViews(unsafe)).toEqual(['notes'])
  })
})
