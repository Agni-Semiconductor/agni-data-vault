import { describe, expect, it } from 'vitest'
import { colorForMaterial, stackSummary } from '../src/pages/parts/StackVisual'

describe('StackVisual helpers', () => {
  it('summarizes layers with thickness', () => expect(stackSummary([{ role: 'fe', material: 'AlScN', t_nm: 20 }])).toBe('AlScN 20 nm'))
  it('omits unknown thickness', () => expect(stackSummary([{ role: 'substrate', material: 'Sapphire', t_nm: null }])).toBe('Sapphire'))
  it('preserves bottom-up summary order', () => expect(stackSummary([{ role: 'substrate', material: 'Sapphire', t_nm: null }, { role: 'fe', material: 'HfN', t_nm: 100 }])).toBe('Sapphire / HfN 100 nm'))
  it('uses a dash for an empty stack', () => expect(stackSummary([])).toBe('—'))
  it('returns a stable case-insensitive color', () => expect(colorForMaterial('AlScN')).toBe(colorForMaterial('alscn')))
  it('returns a hex color', () => expect(colorForMaterial('HfN')).toMatch(/^#[0-9a-f]{6}$/i))
})
