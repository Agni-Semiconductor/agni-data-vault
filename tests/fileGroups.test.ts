import { describe, expect, it } from 'vitest'
import { groupFilesByMeasurement, primaryDataFile, primaryImageFile } from '../src/lib/fileGroups'
import type { VaultFile } from '../src/lib/types'

const file = (id: string, measurement_id: string, kind: string, original_name: string): VaultFile => ({ id, measurement_id, kind, original_name, storage_path: id, size_bytes: null, sha256: null, parsed: {}, upload_state: 'ready', created_by: null, created_at: '2026-01-01' })

describe('file groups', () => {
  it('groups files by measurement', () => { const groups = groupFilesByMeasurement([file('a', 'one', 'other', 'a.txt'), file('b', 'two', 'other', 'b.txt'), file('c', 'one', 'other', 'c.txt')]); expect(groups.get('one')?.map((item) => item.id)).toEqual(['a', 'c']); expect(groups.get('two')).toHaveLength(1) })
  it('returns empty groups for an empty list', () => expect(groupFilesByMeasurement([]).size).toBe(0))
  it('prefers raw xls data', () => expect(primaryDataFile([file('csv', 'm', 'raw_csv', 'a.csv'), file('xls', 'm', 'raw_xls', 'a.xlsx')])?.id).toBe('xls'))
  it('prefers raw csv over a matching extension', () => expect(primaryDataFile([file('text', 'm', 'other', 'a.tsv'), file('csv', 'm', 'raw_csv', 'a.csv')])?.id).toBe('csv'))
  it('finds data by filename extension', () => expect(primaryDataFile([file('text', 'm', 'other', 'curve.TXT')])?.id).toBe('text'))
  it('detects primary images by kind', () => expect(primaryImageFile([file('plot', 'm', 'plot_png', 'whatever.bin')])?.id).toBe('plot'))
  it('detects primary images by extension', () => expect(primaryImageFile([file('image', 'm', 'other', 'curve.JPEG')])?.id).toBe('image'))
  it('returns undefined for empty file choices', () => { expect(primaryDataFile([])).toBeUndefined(); expect(primaryImageFile([])).toBeUndefined() })
})
