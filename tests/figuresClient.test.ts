import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFigure, deleteFigure, getFigure, getKinds, listFigures, updateFigure, type FigureSpec } from '../src/lib/figures'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FIGURE_SORT_KEYS, asFigureSortKey } from '../src/lib/figures'
import { COHORT_SORT_KEYS, asCohortSortKey } from '../src/lib/cohorts'
import { DEVICE_SORT_KEYS, VERDICT_SORT_KEYS } from '../src/lib/devices'

const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}})
const spec:FigureSpec={layout:'1x1',panels:[{unit:'A',traces:[{src:{file_id:'file-1'},x:'voltage',y:'current',label:'device'}]}]}
let calls:Array<[string,RequestInit]>

function stub(body:unknown){calls=[];vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{calls.push([String(input),init??{}]);return json(body)}))}
beforeEach(()=>{calls=[]})
afterEach(()=>vi.unstubAllGlobals())

describe('figures client wire contract',()=>{
  it('lists figures with every supported query parameter',async()=>{stub({items:[],total:0});await listFigures({q:'paper figure',created_by:'a@agni.test',sort:'title',order:'asc',limit:25,offset:50});expect(calls[0][0]).toBe('/api/figures?q=paper+figure&created_by=a%40agni.test&sort=title&order=asc&limit=25&offset=50');expect(calls[0][1].method).toBeUndefined();expect(calls[0][1].body).toBeUndefined()})

  it('gets a figure by encoded id and surfaces its sources',async()=>{const source={figure_id:'figure-1',title:'Paper',panel_index:0,trace_index:0,file_id:'file-1',capture_id:null,label:'device',source_exists:true};stub({figure:{id:'figure-1',spec},sources:[source]});const result=await getFigure('paper/one');expect(calls[0][0]).toBe('/api/figures/paper%2Fone');expect(calls[0][1].method).toBeUndefined();expect(calls[0][1].body).toBeUndefined();expect(result.sources).toEqual([source])})

  it('creates a figure with POST and the contract body',async()=>{const payload={title:'Paper',spec,description:'caption',slug:'paper-1',pinned_extractor_version:null};stub({figure:{id:'figure-1',...payload}});await createFigure(payload);expect(calls[0][0]).toBe('/api/figures');expect(calls[0][1].method).toBe('POST');expect(JSON.parse(String(calls[0][1].body))).toEqual(payload)})

  it('updates a figure with PATCH and only the supplied fields',async()=>{const patch={title:'Revised',description:null};stub({figure:{id:'figure-1',spec,...patch}});await updateFigure('paper-1',patch);expect(calls[0][0]).toBe('/api/figures/paper-1');expect(calls[0][1].method).toBe('PATCH');expect(JSON.parse(String(calls[0][1].body))).toEqual(patch)})

  it('deletes a figure with DELETE and no body',async()=>{stub({deleted:true});await deleteFigure('paper-1');expect(calls[0][0]).toBe('/api/figures/paper-1');expect(calls[0][1].method).toBe('DELETE');expect(calls[0][1].body).toBeUndefined()})

  it('gets all three kind registries with GET and no body',async()=>{const response={items:[],units:[],column_units:[]};stub(response);await expect(getKinds()).resolves.toEqual(response);expect(calls[0][0]).toBe('/api/kinds');expect(calls[0][1].method).toBeUndefined();expect(calls[0][1].body).toBeUndefined()})
})

describe('the client and the API agree on what is sortable', () => {
  it('FIGURE_SORT_KEYS matches figures.js SORT_KEYS exactly', () => {
    // Two copies of an allow-list is how a header ends up claiming a sort the server never
    // applied: parseSort returns null for a key it does not know and figures.js falls back to
    // updated_at desc, so the rows come back in a different order than the column indicator
    // shows and nothing errors. Read the server's list from source rather than restating it --
    // a restated copy is a third copy.
    const source = readFileSync(resolve(process.cwd(), 'api/_lib/resources/figures.js'), 'utf8')
    const match = source.match(/const SORT_KEYS = \[([^\]]*)\]/)
    expect(match, 'SORT_KEYS not found in figures.js -- this test pins it, so a rename must fail here').toBeTruthy()
    const server = match![1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    expect([...FIGURE_SORT_KEYS].sort()).toEqual(server.sort())
  })

  it('an unknown sort key from the URL is dropped, not forwarded', () => {
    expect(asFigureSortKey('title')).toBe('title')
    expect(asFigureSortKey('spec')).toBeUndefined()
    expect(asFigureSortKey('id; drop table')).toBeUndefined()
    expect(asFigureSortKey(undefined)).toBeUndefined()
  })
})

describe('the cohorts client and API agree on what is sortable too', () => {
  it('COHORT_SORT_KEYS matches cohorts.js SORT_KEYS exactly', () => {
    // Same trap as figures: parseSort returns null for an unknown key and the resource falls
    // back to updated_at desc, so the table shows a sort indicator on a column the server never
    // sorted by. Read the server's list from source; a restated copy is a third copy.
    const source = readFileSync(resolve(process.cwd(), 'api/_lib/resources/cohorts.js'), 'utf8')
    const match = source.match(/const SORT_KEYS = \[([^\]]*)\]/)
    expect(match, 'SORT_KEYS not found in cohorts.js -- this test pins it, so a rename must fail here').toBeTruthy()
    const server = match![1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    expect([...COHORT_SORT_KEYS].sort()).toEqual(server.sort())
  })

  it('drops an unknown cohort sort key rather than forwarding it', () => {
    expect(asCohortSortKey('name')).toBe('name')
    expect(asCohortSortKey('predicate')).toBeUndefined()
    expect(asCohortSortKey(undefined)).toBeUndefined()
  })
})

describe('and the devices client agrees with its API too', () => {
  it('DEVICE_SORT_KEYS matches devices.js DEVICE_SORT_KEYS exactly', () => {
    // Third time this parity check has caught two workers writing two different allow-lists.
    // They cannot see each other's files, so the test is the only thing that closes the gap.
    const source = readFileSync(resolve(process.cwd(), 'api/_lib/resources/devices.js'), 'utf8')
    const match = source.match(/const DEVICE_SORT_KEYS = \[([^\]]*)\]/)
    expect(match, 'DEVICE_SORT_KEYS not found in devices.js -- this test pins it').toBeTruthy()
    const server = match![1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    expect([...DEVICE_SORT_KEYS].sort()).toEqual(server.sort())
  })

  it('VERDICT_SORT_KEYS matches too, and covers every column the report displays', () => {
    // The verdict report had NO sorting at all and a hardcoded ascending order, so the oldest
    // degradation sat on page one of a "what changed" report. Adding sorting meant a fourth
    // copy of an allow-list appeared (server, client, the page's own local one, and the type);
    // they are one list now, and this pins it.
    const source = readFileSync(resolve(process.cwd(), 'api/_lib/resources/devices.js'), 'utf8')
    const match = source.match(/const VERDICT_SORT_KEYS = \[([^\]]*)\]/)
    expect(match, 'VERDICT_SORT_KEYS not found in devices.js').toBeTruthy()
    const server = match![1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    expect([...VERDICT_SORT_KEYS].sort()).toEqual(server.sort())
    // Every column the table renders must be sortable, or a header shows an arrow for a sort
    // the server quietly refused.
    for (const column of ['device_address', 'prev_verdict', 'new_verdict', 'direction', 'prev_run_id', 'run_id', 'started_at'])
      expect(VERDICT_SORT_KEYS, `${column} is a table column but not sortable`).toContain(column)
  })
})
