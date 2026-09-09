/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/supabase', () => ({ supabase: { from: vi.fn(), auth: { getUser: vi.fn() }, storage: { from: vi.fn() } } }))
import { kindFromName, listSamples, parseFilenameClient } from '../src/lib/api'
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
  it('uses OR predicates for meta select any-of filters', async () => { const calls:string[]=[]; const q:any={select:()=>q,or:(value:string)=>{calls.push(value);return q},order:()=>q,range:()=>Promise.resolve({data:[],error:null,count:0}),gte:()=>q,lte:()=>q,eq:()=>q,in:()=>q,contains:()=>q}; const client=(await import('../src/lib/supabase')).supabase as unknown as {from:{mockReturnValue:(value:unknown)=>void}}; client.from.mockReturnValue(q); await listSamples({filters:{owner:['a','b']},defs:[{key:'owner',type:'select',column_name:null} as any]}); expect(calls).toContain('meta->>owner.eq.a,meta->>owner.eq.b') })
  it('applies META number ranges after fetching', async () => { const q:any={select:()=>q,or:()=>q,order:()=>q,range:()=>q,gte:()=>q,lte:()=>q,eq:()=>q,in:()=>q,contains:()=>q,then:(resolve:any)=>resolve({data:[{meta:{temp:5}},{meta:{temp:15}}],error:null,count:2})}; const client=(await import('../src/lib/supabase')).supabase as unknown as {from:{mockReturnValue:(value:unknown)=>void}}; client.from.mockReturnValue(q); const result=await listSamples({filters:{temp:{min:10}},defs:[{key:'temp',type:'number',column_name:null} as any]}); expect(result.items).toEqual([{meta:{temp:15}}]) })
})
