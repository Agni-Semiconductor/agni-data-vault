import { describe, expect, it } from 'vitest'
import { aliasSummary, groupHistoryByDay, orderHistoryOldestFirst, schemeExplanation, type DeviceAlias, type DeviceHistoryEvent } from '../src/lib/devices'

const measurement:DeviceHistoryEvent={device_id:'device-1',sample_id:'sample-1',device_address:'D116',event_kind:'measurement',event_id:'measurement-1',occurred_at:'2026-09-03T10:00:00Z',detail:'dciv',verdict:null,source:'k4200a',run_id:null}
const bench:DeviceHistoryEvent={device_id:'device-1',sample_id:'sample-1',device_address:'D116',event_kind:'bench_cell',event_id:'cell-1',occurred_at:'2026-09-01T10:00:00Z',detail:'completed',verdict:'short',source:'dut-1',run_id:'run-1'}

describe('device history helpers',()=>{
  it('orders the mixed timeline oldest first',()=>expect(orderHistoryOldestFirst([measurement,bench]).map(event=>event.event_id)).toEqual(['cell-1','measurement-1']))
  it('groups ordered events by their calendar day without flattening their kinds',()=>{const groups=groupHistoryByDay([measurement,bench]);expect(groups.map(group=>group.day)).toEqual(['2026-09-01','2026-09-03']);expect(groups[0].items[0].event_kind).toBe('bench_cell');expect(groups[1].items[0].event_kind).toBe('measurement')})
  it('keeps an alias confirmation and reason visible',()=>{const alias:DeviceAlias={id:'alias-1',device_id:'device-1',alias_address:'D116_116',alias_scheme:'bench_grid',reason:'Confirmed against probe card record',confirmed_by:'scientist@agni.test',confirmed_at:'2026-09-04T10:00:00Z'};expect(aliasSummary(alias)).toBe('D116_116 (bench_grid) was confirmed by scientist@agni.test: Confirmed against probe card record')})
  it('explains why vault labels do not have invented grid coordinates',()=>expect(schemeExplanation('vault_label',null,null)).toContain('carries no die geometry'))
  it('explains the exact bench grid coordinates',()=>expect(schemeExplanation('bench_grid',116,116)).toContain('row 116, column 116'))
})
