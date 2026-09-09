import { Pencil } from 'lucide-react'
import { Button } from '../../components/ui'
import { getFieldValue, groupDefs, formatValue, ProvenanceChip } from '../../fields'
import type { FieldDef, Measurement, OptionValue, Sample } from '../../lib/types'

export function MetaGrid({ defs, lists, row, onEdit }: { defs: FieldDef[]; lists: Record<string, OptionValue[]>; row: Sample | Measurement; onEdit?: () => void }) {
  const hasValue = (def: FieldDef) => { const value = getFieldValue(def, row as unknown as Record<string, unknown> & { meta?: Record<string, unknown> }); return value !== null && value !== undefined && value !== '' }
  const active = defs.filter((def) => def.active)
  const retired = defs.filter((def) => !def.active && hasValue(def))
  const cells = (items: FieldDef[]) => groupDefs(items).map(({ group, defs: grouped }) => <section key={group} className="space-y-2"><h3 className="label-caps">{group}</h3><dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">{grouped.map((def) => { const value = getFieldValue(def, row as unknown as Record<string, unknown> & { meta?: Record<string, unknown> }); return <div key={def.key} className="min-w-0"><dt className="text-xs text-agni-slate">{def.label}</dt><dd className="flex items-center gap-1 break-words text-sm text-agni-ink"><span>{formatValue(def, value, lists) || '—'}</span>{row.meta_status[def.key] && <ProvenanceChip status={row.meta_status[def.key]} />}</dd></div> })}</dl></section>)
  return <div className="space-y-5 rounded-lg border border-border-subtle bg-white p-4 shadow-card"><div className="flex items-center justify-between"><h2 className="font-semibold">Metadata</h2>{onEdit && <Button type="button" size="sm" variant="secondary" aria-label="Edit metadata" onClick={onEdit}><Pencil size={15} />Edit</Button>}</div>{cells(active)}{retired.length > 0 && <details><summary className="cursor-pointer text-sm text-agni-slate">Retired fields</summary><div className="mt-4">{cells(retired)}</div></details>}</div>
}
