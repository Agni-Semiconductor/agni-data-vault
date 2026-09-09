import { describe, expect, it } from 'vitest'
import { KEY_RE, SLUG_RE, nextSortOrder, slugify, validateFieldDef, validateOptionValue } from '../src/pages/admin/adminValidation'

describe('admin validation', () => {
  it('accepts a valid key', () => expect(KEY_RE.test('anneal_temp')).toBe(true))
  it('rejects an uppercase key', () => expect(KEY_RE.test('Anneal')).toBe(false))
  it('rejects a numeric-leading key', () => expect(KEY_RE.test('2temp')).toBe(false))
  it('detects duplicate field keys', () => expect(validateFieldDef({ entity: 'sample', key: 'owner', label: 'Owner', type: 'text' }, ['owner']).key).toBeTruthy())
  it('requires a list for select', () => expect(validateFieldDef({ entity: 'sample', key: 'owner', label: 'Owner', type: 'select' }, []).options_list_key).toBeTruthy())
  it('rejects a bad column', () => expect(validateFieldDef({ entity: 'file', key: 'x', label: 'X', type: 'text', column_name: 'notes' }, []).column_name).toBeTruthy())
  it('rejects an inverted range', () => expect(validateFieldDef({ entity: 'sample', key: 'x', label: 'X', type: 'number', min: 4, max: 3 }, []).max).toBeTruthy())
  it('validates regular expressions', () => expect(validateFieldDef({ entity: 'sample', key: 'x', label: 'X', type: 'text', regex: '[' }, []).regex).toBeTruthy())
  it('slugifies labels', () => expect(slugify('Anneal Temp (C)')).toBe('anneal_temp_c'))
  it('starts sort order at ten', () => expect(nextSortOrder([])).toBe(10))
  it('increments maximum sort order', () => expect(nextSortOrder([{ sort_order: 30 }])).toBe(40))
  it('accepts option slugs', () => expect(SLUG_RE.test('dc-iv.1')).toBe(true))
  it('rejects bad option slugs', () => expect(validateOptionValue({ label: 'DC IV', value: 'DC IV' }, []).value).toBeTruthy())
  it('detects duplicate option values', () => expect(validateOptionValue({ label: 'DC IV', value: 'dciv' }, ['dciv']).value).toBeTruthy())
})
