import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseFile, sniffSource } from '../src/plot/parseFile'
const bytes = (text: string) => new TextEncoder().encode(text)
const workbook = (names: string[]) => { const wb = XLSX.utils.book_new(); names.forEach((name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['BI', 'BV', 'AI', 'AV'], [1e-9, 0, 2e-9, .25]]), name)); return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) }
describe('parseFile', () => {
  it('sniffs xlsx', () => expect(sniffSource(new Uint8Array([0x50, 0x4b, 3, 4]), 'x')).toBe('xlsx'))
  it('sniffs biff', () => expect(sniffSource(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'x')).toBe('xls_biff'))
  it('sniffs html', () => expect(sniffSource(bytes(' <table>'), 'x.xls')).toBe('xls_html'))
  it('sniffs csv', () => expect(sniffSource(bytes('a,b'), 'x.csv')).toBe('csv'))
  it('sniffs tsv', () => expect(sniffSource(bytes('a\tb'), 'x.txt')).toBe('tsv'))
  it('selects Data and hides metadata sheets', () => { const p = parseFile(workbook(['Calc', 'Data', 'Settings']), 'dciv.xlsx'); expect(p.sheet).toBe('Data'); expect(p.headers).toEqual(['BI', 'BV', 'AI', 'AV']); expect(p.sheets).toEqual(['Data']); expect(p.detected_kind).toBe('dciv') })
  it('selects first non-meta PUND sheet', () => expect(parseFile(workbook(['Run6768', 'Calc', 'Run6767']), 'pund.xlsx').sheet).toBe('Run6768'))
  it('honours selected sheet', () => expect(parseFile(workbook(['Data', 'Run2']), 'x.xlsx', { sheet: 'Run2' }).sheet).toBe('Run2'))
  it('parses HTML table xls', () => { const p = parseFile(bytes('<table><tr><td>V</td><td>C</td></tr><tr><td>1</td><td>2</td></tr></table>'), 'x.xls'); expect(p.source).toBe('xls_html'); expect(p.headers).toEqual(['V', 'C']) })
  it('parses board metadata and sentinel', () => { const p = parseFile(bytes('# {"kind":"dciv","cell":"D0_5"}\nindex,v_applied,current_mA\n0,1,7e22'), 'run.csv'); expect(p.campaign_meta?.cell).toBe('D0_5'); expect(p.rows[0][2]).toBeNull(); expect(p.detected_kind).toBe('board_csv') })
  it('unquotes CSV metadata', () => expect(parseFile(bytes('# "{""cell"":""D0_5""}"\nindex,v_applied\n0,1'), 'x.csv').campaign_meta?.cell).toBe('D0_5'))
  it('parses TSV numeric values', () => { const p = parseFile(bytes('V\tC\n1\t2'), 'x.tsv'); expect(p.source).toBe('tsv'); expect(p.rows[0]).toEqual([1, 2]) })
  it('drops empty rows', () => expect(parseFile(bytes('a,b\n\n1,2\n,'), 'x.csv').n_rows).toBe(1))
})
