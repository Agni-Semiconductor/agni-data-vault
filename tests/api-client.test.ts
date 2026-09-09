import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/supabase', () => ({ supabase: { from: vi.fn(), auth: { getUser: vi.fn() }, storage: { from: vi.fn() } } }))
import { kindFromName, parseFilenameClient } from '../src/lib/api'
describe('api client filename helpers', () => {
  it('parses a DCIV run and date', () => expect(parseFilenameClient('Dhiren Site@1 Subsite capacitor DC-IV#1 Run4482 04-21-2026.xlsx')).toEqual({run_number:4482,file_date:'2026-04-21',detected_kind:'dciv'}))
  it('detects PUND', () => expect(parseFilenameClient('20-PUND-3.xlsx').detected_kind).toBe('pund'))
  it('detects ACIV', () => expect(parseFilenameClient('hysteresis Run2.xlsx').detected_kind).toBe('aciv'))
  it('detects CV', () => expect(parseFilenameClient('device CV.csv').detected_kind).toBe('cv'))
  it('returns null metadata when absent', () => expect(parseFilenameClient('notes.txt')).toEqual({run_number:null,file_date:null,detected_kind:null}))
  it('classifies xlsx', () => expect(kindFromName('raw.XLSX')).toBe('raw_xls'))
  it('classifies csv', () => expect(kindFromName('raw.csv')).toBe('raw_csv'))
  it('classifies plots', () => expect(kindFromName('plot.png')).toBe('plot_png'))
  it('classifies other files', () => expect(kindFromName('readme.pdf')).toBe('other'))
})
