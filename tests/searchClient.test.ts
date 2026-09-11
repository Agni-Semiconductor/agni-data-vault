import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptSearch, askSearch, listSearchHistory } from '../src/lib/search'

const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}})
let calls:Array<[string,RequestInit]>
function stub(body:unknown){calls=[];vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{calls.push([String(input),init??{}]);return json(body)}))}
beforeEach(()=>{calls=[]})
afterEach(()=>vi.unstubAllGlobals())

describe('search client wire contract',()=>{
  it('asks with POST and the question body',async()=>{stub({refusal:'No matching field.',unknown_terms:['yield'],query_id:'query-1'});const result=await askSearch('Which samples have high yield?');expect(calls[0][0]).toBe('/api/search/ask');expect(calls[0][1].method).toBe('POST');expect(JSON.parse(String(calls[0][1].body))).toEqual({question:'Which samples have high yield?'});if('refusal' in result)expect(result.refusal).toBe('No matching field.');else throw new Error('Expected a refusal result')})
  it('returns a filter result as the filter branch',async()=>{stub({url:'/measurements?temperature_c=300',entity:'measurement',filters:{temperature_c:300},explanation:'Selects measurements at 300 C.',unknown_terms:[],query_id:'query-2'});const result=await askSearch('Measurements at 300 C');if('url' in result){expect(result.url).toBe('/measurements?temperature_c=300');expect(result.filters).toEqual({temperature_c:300})}else throw new Error('Expected a filter result')})
  it('records acceptance at the query-specific POST path',async()=>{stub({ok:true});await acceptSearch('query/id');expect(calls[0][0]).toBe('/api/search/query%2Fid/accepted');expect(calls[0][1].method).toBe('POST');expect(calls[0][1].body).toBeUndefined()})
  it('lists history with GET and its query parameters',async()=>{stub({items:[],total:0});await listSearchHistory({q:'anneal',refused:true,limit:25,offset:50});expect(calls[0][0]).toBe('/api/search/history?q=anneal&refused=1&limit=25&offset=50');expect(calls[0][1].method).toBeUndefined();expect(calls[0][1].body).toBeUndefined()})
})
