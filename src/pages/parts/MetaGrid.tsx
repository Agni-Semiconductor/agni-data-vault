import { Pencil } from 'lucide-react'
import { Badge, Button } from '../../components/ui'
import { getFieldValue, groupDefs, formatValue, ProvenanceChip } from '../../fields'
import type { FieldDef, Measurement, OptionValue, Sample } from '../../lib/types'

type RowLike = Record<string, unknown> & { meta?: Record<string, unknown> }
const WRAP = 'break-words [overflow-wrap:anywhere]'

const evidenceRows = (value: unknown): [string, string, string][] | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return null
  const rows: [string, string, string][] = []
  for (const [field, item] of entries) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    if (!('class' in record) || !('source' in record)) return null
    rows.push([field, record.class === null || record.class === undefined ? '' : String(record.class), record.source === null || record.source === undefined ? '' : String(record.source)])
  }
  return rows
}

function EvidenceTable({ value }: { value: unknown }) {
  const rows = evidenceRows(value)
  if (!rows) return null
  return <table className="w-full border-collapse text-sm"><thead><tr><th className="border-b border-border-subtle p-1 text-left text-xs font-medium text-agni-slate">Field</th><th className="border-b border-border-subtle p-1 text-left text-xs font-medium text-agni-slate">Class</th><th className="border-b border-border-subtle p-1 text-left text-xs font-medium text-agni-slate">Source</th></tr></thead><tbody>{rows.map(([field, klass, source]) => <tr key={field}><td className={`border-b border-border-subtle p-1 font-mono text-xs ${WRAP}`}>{field}</td><td className="border-b border-border-subtle p-1">{klass ? <Badge tone="blue">{klass}</Badge> : '—'}</td><td className={`border-b border-border-subtle p-1 ${WRAP}`}>{source || '—'}</td></tr>)}</tbody></table>
}

export function MetaGrid({ defs, lists, row, onEdit }: { defs: FieldDef[]; lists: Record<string, OptionValue[]>; row: Sample | Measurement; onEdit?: () => void }) {
  const hasValue = (def: FieldDef) => { const value = getFieldValue(def, row as unknown as RowLike); return value !== null && value !== undefined && value !== '' }
  const active = defs.filter((def) => def.active)
  const retired = defs.filter((def) => !def.active && hasValue(def))
  const cells = (items: FieldDef[]) => groupDefs(items).map(({ group, defs: grouped }) => <section key={group} className="space-y-2"><h3 className="label-caps">{group}</h3><dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">{grouped.map((def) => { const value = getFieldValue(def, row as unknown as RowLike); const chip = row.meta_status[def.key] ? <ProvenanceChip status={row.meta_status[def.key]} /> : null; const label = <dt className="flex items-center gap-1 text-xs text-agni-slate">{def.label}{chip}</dt>; if (def.type === 'json' || def.type === 'longtext') { const text = formatValue(def, value, lists); return <div key={def.key} className="col-span-full min-w-0">{label}<dd className={`mt-0.5 text-sm text-agni-ink ${WRAP}`}>{def.key === 'evidence' && evidenceRows(value) ? <EvidenceTable value={value} /> : <pre className="font-mono text-xs whitespace-pre-wrap break-all rounded-md border border-border-subtle bg-surface-2 p-2 max-h-64 overflow-auto">{text || '—'}</pre>}</dd></div> } return <div key={def.key} className="min-w-0">{label}<dd className={`mt-0.5 text-sm text-agni-ink ${WRAP}`}>{formatValue(def, value, lists) || '—'}</dd></div> })}</dl></section>)
  return <div className="space-y-5 rounded-lg border border-border-subtle bg-white p-4 shadow-card"><div className="flex items-center justify-between"><h2 className="font-semibold">Metadata</h2>{onEdit && <Button type="button" size="sm" variant="secondary" aria-label="Edit metadata" onClick={onEdit}><Pencil size={15} />Edit</Button>}</div>{cells(active)}{retired.length > 0 && <details><summary className="cursor-pointer text-sm text-agni-slate">Retired fields</summary><div className="mt-4">{cells(retired)}</div></details>}</div>
}
