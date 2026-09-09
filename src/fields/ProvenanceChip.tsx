import { Badge } from '../components/ui'
import type { MetaStatus } from '../lib/types'
const next: Record<MetaStatus, MetaStatus> = { confirmed: 'assumed', assumed: 'unknown', unknown: 'confirmed' }
const tone: Record<MetaStatus, 'green' | 'amber' | 'gray'> = { confirmed: 'green', assumed: 'amber', unknown: 'gray' }
export function ProvenanceChip({ status, onChange }: { status: MetaStatus; onChange?: (status: MetaStatus) => void }) { return <button type="button" title="Data confidence; click to cycle confirmed, assumed, and unknown" onClick={() => onChange?.(next[status])} className="shrink-0"><Badge tone={tone[status]}>{status}</Badge></button> }
