export type Unit = { unit: string; quantity: string; si_factor: number; label?: string | null }
export type ColumnUnit = { column_name: string; unit: string; notes?: string | null }
export type MeasurementKind = { kind: string; label: string; x_col: string[]; y_col: string[]; y2_col: string[] | null; x_unit: string | null; y_unit: string | null; y2_unit: string | null; abs_y: boolean; log_y: boolean; derivable: string[]; notes: string | null }
export type KindsResponse = { items: MeasurementKind[]; units: Unit[]; column_units: ColumnUnit[] }
export type UnitRegistry = { units: Record<string, Unit>; columnUnits: Record<string, string>; kinds: Record<string, MeasurementKind> }
export type TraceRefusal = { reason: string; from: string | null; to: string }
type TraceUnitInput = { column?: string | null; kindAxisUnit: string | null }
// panelUnit NULL means the panel has not committed to a unit yet, and this trace's own unit
// becomes it. A panel cannot know its unit before its first accepted trace -- the spec may
// leave `unit` off entirely -- and without this the first trace can never be checked, so the
// panel can never acquire a unit and every trace is refused. Once set, every later trace is
// held to it.
type TraceCheckInput = TraceUnitInput & { panelUnit: string | null }
/** The unit the trace was converted TO -- the panel's, or its own when the panel adopted it. */
export type TraceAccepted = { factor: number; unit: string }
const key = (value: string) => value.toLowerCase()
const named = (unit: string | null) => unit ?? 'unknown unit'

export function buildRegistry(response: KindsResponse): UnitRegistry {
  const units: Record<string, Unit> = {}; const columnUnits: Record<string, string> = {}; const kinds: Record<string, MeasurementKind> = {}
  for (const unit of response.units) units[key(unit.unit)] = unit
  for (const column of response.column_units) columnUnits[key(column.column_name)] = column.unit
  for (const kind of response.items) kinds[key(kind.kind)] = kind
  return { units, columnUnits, kinds }
}
export const columnUnit = (reg: UnitRegistry, column: string) => reg.columnUnits[key(column)] ?? null
const registeredUnit = (reg: UnitRegistry, unit: string | null) => unit === null ? null : reg.units[key(unit)] ?? null
export function unitsCompatible(reg: UnitRegistry, from: string | null, to: string | null): boolean {
  const source = registeredUnit(reg, from); const target = registeredUnit(reg, to)
  return source !== null && target !== null && source.quantity === target.quantity
}
export function unitFactor(reg: UnitRegistry, from: string, to: string): number {
  const source = registeredUnit(reg, from); const target = registeredUnit(reg, to)
  if (source === null || target === null) throw new Error(`cannot convert ${named(from)} to ${named(to)}: unknown unit`)
  if (source.quantity !== target.quantity) throw new Error(`cannot convert ${source.unit} (${source.quantity}) to ${target.unit} (${target.quantity})`)
  if (source.unit === target.unit) return 1
  return source.si_factor / target.si_factor
}
export function resolveTraceUnit(reg: UnitRegistry, { column, kindAxisUnit }: TraceUnitInput): { unit: string | null; source: 'column' | 'axis' } {
  // Falling back after a named column misses the legacy-milliamps error without leaving a visible gap.
  if (column !== null && column !== undefined) return { unit: columnUnit(reg, column), source: 'column' }
  return { unit: kindAxisUnit, source: 'axis' }
}
export function convertTrace(reg: UnitRegistry, values: number[], from: string, to: string): { values: number[]; factor: number } {
  const factor = unitFactor(reg, from, to)
  return { values: values.map((value) => value * factor), factor }
}
export function checkTrace(reg: UnitRegistry, { column, kindAxisUnit, panelUnit }: TraceCheckInput): TraceRefusal | TraceAccepted {
  const resolved = resolveTraceUnit(reg, { column, kindAxisUnit }); const from = resolved.unit
  // An UNREGISTERED column is unknown, and unknown is REFUSED -- never quietly given the panel's
  // unit. That fallback is exactly how current_mA ends up labelled amperes, 1000x high, on a log
  // axis, looking like data. Refused even when the panel has no unit yet: adopting an unknown
  // unit would make every later trace agree with nothing.
  if (from === null) return { reason: `column ${column ?? 'unknown'} is unregistered (unknown); panel axis is ${named(panelUnit)}`, from, to: named(panelUnit) }
  if (panelUnit === null) return { factor: 1, unit: from }
  if (!unitsCompatible(reg, from, panelUnit)) return { reason: `trace unit is ${from}; panel axis is ${panelUnit}`, from, to: panelUnit }
  return { factor: unitFactor(reg, from, panelUnit), unit: panelUnit }
}
