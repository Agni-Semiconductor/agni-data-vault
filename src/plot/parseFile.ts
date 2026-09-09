import * as Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { detectKind, type PlotKind } from './plotProfiles'

export type { PlotKind } from './plotProfiles'
export type Cell = number | string | null
export type ParsedFile = { headers: string[]; rows: Cell[][]; n_rows: number; sheet?: string; sheets?: string[]; campaign_meta?: Record<string, unknown>; detected_kind: PlotKind | null; source: 'xlsx' | 'xls_biff' | 'xls_html' | 'tsv' | 'csv' }

const META_SHEETS = /^(calc|settings|summary|setup|notes)$/i
const numeric = /^-?\d*\.?\d+(e[-+]?\d+)?$/i

export function sniffSource(bytes: Uint8Array, name: string): ParsedFile['source'] {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'xls_biff'
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx'
  const first = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '').trimStart()[0]
  if (first === '<') return 'xls_html'
  return /\.csv$/i.test(name) ? 'csv' : 'tsv'
}

function cell(value: unknown): Cell {
  if (value === null || value === undefined || value === '') return null
  const valueNumber = typeof value === 'number' ? value : typeof value === 'string' && numeric.test(value.trim()) ? Number(value) : null
  if (valueNumber !== null) return Math.abs(valueNumber) >= 1e22 ? null : valueNumber // 7e22 is Clarius/board's unmeasured sentinel.
  return typeof value === 'string' ? value : String(value)
}
function nonEmpty(row: unknown[]): boolean { return row.some((value) => value !== null && value !== undefined && value !== '') }
function normalize(headers: unknown[], rows: unknown[][]): { headers: string[]; rows: Cell[][] } {
  return { headers: headers.map((header) => String(header ?? '').trim()), rows: rows.filter(nonEmpty).map((row) => row.map(cell)) }
}
function text(bytes: Uint8Array): string { return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '') }
function parseCampaignMeta(line: string): Record<string, unknown> {
  const raw = line.replace(/^#/, '').trim()
  const json = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw
  try { const parsed: unknown = JSON.parse(json); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { raw: line } } catch { return { raw: line } }
}

export function parseFile(input: ArrayBuffer | Uint8Array, name: string, opts?: { sheet?: string }): ParsedFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const source = sniffSource(bytes, name)
  let headers: string[] = []; let rows: Cell[][] = []; let sheet: string | undefined; let sheets: string[] | undefined; let campaign_meta: Record<string, unknown> | undefined
  if (source === 'xlsx' || source === 'xls_biff' || source === 'xls_html') {
    const workbook = XLSX.read(bytes, { type: 'array' })
    sheets = workbook.SheetNames.filter((sheetName) => !META_SHEETS.test(sheetName))
    sheet = opts?.sheet && sheets.includes(opts.sheet) ? opts.sheet : sheets.find((sheetName) => sheetName.toLowerCase() === 'data') ?? sheets[0]
    const matrix = sheet && workbook.Sheets[sheet] ? XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheet], { header: 1, raw: true, defval: null }) : []
    const headerIndex = matrix.findIndex(nonEmpty); const workbookRows = headerIndex < 0 ? [] : matrix.slice(headerIndex + 1)
    ;({ headers, rows } = normalize(headerIndex < 0 ? [] : matrix[headerIndex], workbookRows))
  } else {
    let sourceText = text(bytes)
    if (source === 'csv' && sourceText.trimStart().startsWith('#')) {
      const match = sourceText.match(/^([^\r\n]*)(?:\r?\n|$)/); const metaLine = match?.[1] ?? ''
      campaign_meta = parseCampaignMeta(metaLine); sourceText = sourceText.slice(metaLine.length).replace(/^\r?\n/, '')
    }
    const parsedRows = Papa.parse<unknown[]>(sourceText, { delimiter: source === 'tsv' ? '\t' : undefined, dynamicTyping: true, skipEmptyLines: true }).data
    ;({ headers, rows } = normalize(parsedRows[0] ?? [], parsedRows.slice(1)))
  }
  return { headers, rows, n_rows: rows.length, ...(sheet ? { sheet } : {}), ...(sheets ? { sheets } : {}), ...(campaign_meta ? { campaign_meta } : {}), detected_kind: detectKind(headers, name), source }
}
