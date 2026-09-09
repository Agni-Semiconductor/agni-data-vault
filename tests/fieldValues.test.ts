import { describe, expect, it } from 'vitest'
import { FIXTURE_LISTS, MEASUREMENT_DEFS, SAMPLE_DEFS } from '../src/fields/fixtures'
import { coerceValue, formatValue, getFieldValue, setFieldValue, splitForWrite, validateEntity, validateValue } from '../src/fields/fieldValues'
const byKey = (key: string) => [...SAMPLE_DEFS,...MEASUREMENT_DEFS].find((def) => def.key === key)!
describe('field values', () => {
  it('gets a column value', () => expect(getFieldValue(byKey('temperature_c'),{temperature_c:25,meta:{}})).toBe(25))
  it('gets a meta value', () => expect(getFieldValue(byKey('sweep_v'),{meta:{sweep_v:18}})).toBe(18))
  it('sets values by location', () => { const row: Record<string,unknown> & {meta:Record<string,unknown>}={meta:{}}; setFieldValue(byKey('temperature_c'),row,25); setFieldValue(byKey('sweep_v'),row,18); expect(row).toMatchObject({temperature_c:25,meta:{sweep_v:18}}) })
  it('coerces a number', () => expect(coerceValue(byKey('temperature_c'),'25').value).toBe(25))
  it('rejects bad number', () => expect(coerceValue(byKey('temperature_c'),'wat').error).toBeDefined())
  it('requires whole integers', () => { const def={...byKey('temperature_c'),type:'integer' as const}; expect(coerceValue(def,'2.5').error).toBeDefined() })
  it('validates real dates', () => expect(coerceValue(byKey('measured_on'),'2026-13-40').error).toBeDefined())
  it('coerces booleans', () => { const def={...byKey('temperature_c'),type:'bool' as const}; expect(coerceValue(def,'0').value).toBe(false) })
  it('splits multiselect strings', () => { const def={...byKey('kind'),type:'multiselect' as const}; expect(coerceValue(def,'dciv, aciv').value).toEqual(['dciv','aciv']) })
  it('parses JSON', () => expect(coerceValue(byKey('run_numbers'),'[4482]').value).toEqual([4482]))
  it('rejects malformed JSON', () => expect(coerceValue(byKey('run_numbers'),'[').error).toBeDefined())
  it('turns empty strings into null', () => expect(coerceValue(byKey('kind'),'').value).toBeNull())
  it('validates required fields', () => expect(validateValue(byKey('sample_id'),null)).toBe('Required'))
  it('validates numeric bounds', () => expect(validateValue(byKey('sweep_v'),201)).toBe('Must be at most 200'))
  it('allows a retired current option', () => expect(validateValue(byKey('substrate'),'soi',FIXTURE_LISTS,'soi')).toBeNull())
  it('rejects a newly selected retired option', () => expect(validateValue(byKey('substrate'),'soi',FIXTURE_LISTS,'sapphire')).toBe('Select a valid option'))
  it('validates an entity', () => expect(validateEntity([byKey('sample_id')],{meta:{}})).toEqual({sample_id:'Required'}))
  it('routes fields for writes', () => { const result=splitForWrite([byKey('temperature_c'),byKey('sweep_v')],{temperature_c:25,sweep_v:18},{temperature_c:'confirmed',sweep_v:'assumed'}); expect(result).toEqual({columns:{temperature_c:25},meta:{sweep_v:18},meta_status:{temperature_c:'confirmed',sweep_v:'assumed'}}) })
  it('formats numbers and option labels', () => { expect(formatValue(byKey('temperature_c'),25,FIXTURE_LISTS)).toBe('25 C'); expect(formatValue(byKey('kind'),'dciv',FIXTURE_LISTS)).toBe('DC-IV') })
  it('formats stacks bottom-up', () => expect(formatValue(byKey('stack'),[{role:'substrate',material:'Sapphire',t_nm:null},{role:'bottom_metal',material:'HfN',t_nm:100},{role:'fe',material:'AlScN',t_nm:20},{role:'top_metal',material:'Al',t_nm:null}])).toBe('Sapphire / HfN 100 / AlScN 20 / Al'))
})
