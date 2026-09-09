import type { ParsedFile } from './parseFile'

export type PlotKind = 'dciv' | 'aciv' | 'pund' | 'pulse' | 'cv' | 'board_csv' | 'other'
export type PlotProfile = { x: string[]; y: string[]; y2?: string[]; abs_y?: boolean; log_y?: boolean }
export const PROFILES: Record<PlotKind, PlotProfile> = {
  dciv: { x: ['AV', 'BV'], y: ['AI', 'BI'], abs_y: true, log_y: true }, aciv: { x: ['Vforce'], y: ['Imeas'], y2: ['Charge'] }, pund: { x: ['Time', 't'], y: ['V'], y2: ['I', 'Psw', 'Qsw'] }, pulse: { x: ['t', 'Time'], y: ['V'], y2: ['I'] }, cv: { x: ['V'], y: ['C'] }, board_csv: { x: ['v_applied'], y: ['i_a', 'current_mA'], y2: ['v_meas'], abs_y: true, log_y: true }, other: { x: [], y: [] },
}
const has = (headers: string[], value: string) => headers.some((header) => header.toLowerCase() === value.toLowerCase())
export function detectKind(headers: string[], filename: string): PlotKind {
  const name = filename.toLowerCase()
  // Board-campaign captures look like cap_<campaign>_r000c002_dciv.csv; a plain *_dciv.csv is a normal DC-IV export.
  if (/(^|[\\/])cap_.*_(dciv|aciv)\.csv$|_r\d{3}c\d{3}_(dciv|aciv)\.csv$/.test(name)) return 'board_csv'
  if (/dc-iv|dciv|dc iv/.test(name)) return 'dciv'; if (/ac iv|ac-iv|aciv|hysteresis/.test(name)) return 'aciv'; if (/pund/.test(name)) return 'pund'; if (/\bcv\b|c-v/.test(name)) return 'cv'
  if (has(headers, 'v_applied')) return 'board_csv'; if (has(headers, 'Psw') && has(headers, 'Qsw')) return 'pund'; if (has(headers, 'Vforce') && has(headers, 'Imeas')) return 'aciv'; if (has(headers, 'AV') && (has(headers, 'AI') || has(headers, 'BI'))) return 'dciv'; if ((has(headers, 't') || has(headers, 'Time')) && has(headers, 'V') && has(headers, 'I')) return 'pulse'; if (has(headers, 'C') && has(headers, 'V')) return 'cv'
  return 'other'
}
const indexOf = (headers: string[], candidate: string) => headers.findIndex((header) => header.toLowerCase() === candidate.toLowerCase())
const number = (value: unknown): number | null => { const result = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(result) ? result : null }
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Infinity }
/** Clarius DC-IV can contain two current channels; use the quieter early baseline. */
export function pickDcivChannel(parsed: ParsedFile): 'AI' | 'BI' { const count = Math.max(1, Math.ceil(parsed.rows.length * .05)); const noise = (channel: string) => { const index = indexOf(parsed.headers, channel); return median(parsed.rows.slice(0, count).map((row) => number(row[index])).filter((v): v is number => v !== null).map(Math.abs)) }; return noise('AI') <= noise('BI') ? 'AI' : 'BI' }
export type ResolvedSeries = { x: number[]; y: (number | null)[]; y2?: (number | null)[]; labels: { x: string; y: string; y2?: string }; log_y: boolean }
export function resolveSeries(parsed: ParsedFile, kind: PlotKind, override?: { x?: string; y?: string; y2?: string; log?: boolean }): ResolvedSeries {
  const profile = PROFILES[kind]; const choose = (given: string | undefined, choices: string[], fallback: number) => given ?? choices.map((choice) => parsed.headers[indexOf(parsed.headers, choice)]).find(Boolean) ?? parsed.headers[fallback] ?? ''
  const xLabel = choose(override?.x, profile.x, 0); const yLabel = choose(override?.y, kind === 'dciv' ? [pickDcivChannel(parsed)] : profile.y, 1); const y2Label = override?.y2 ?? (profile.y2 ?? []).map((choice) => parsed.headers[indexOf(parsed.headers, choice)]).find(Boolean); const useLog = profile.log_y ? override?.log ?? Boolean(profile.log_y) : false; const useAbs = profile.log_y ? useLog : Boolean(profile.abs_y)
  const xi = indexOf(parsed.headers, xLabel); const yi = indexOf(parsed.headers, yLabel); const y2i = y2Label ? indexOf(parsed.headers, y2Label) : -1; const x: number[] = []; const y: (number | null)[] = []; const y2: (number | null)[] = []
  for (const row of parsed.rows) { const xv = number(row[xi]); const yv = number(row[yi]); if (xv === null || yv === null) continue; x.push(xv); const transformed = useAbs ? Math.abs(yv) : yv; y.push(useLog && transformed <= 0 ? null : transformed); if (y2i >= 0) y2.push(number(row[y2i])) }
  return { x, y, ...(y2Label ? { y2 } : {}), labels: { x: xLabel, y: yLabel, ...(y2Label ? { y2: y2Label } : {}) }, log_y: useLog }
}
export function decimate(xs: number[], ys: (number | null)[], max = 5000): { x: number[]; y: (number | null)[] } { const step = Math.max(1, Math.ceil(xs.length / max)); return { x: xs.filter((_, i) => i % step === 0), y: ys.filter((_, i) => i % step === 0) } }
