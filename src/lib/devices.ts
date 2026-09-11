export type AddressScheme = 'bench_grid'|'vault_label'
export type BenchVerdict = 'normal'|'short'|'open'|'no_signal'|'indeterminate'
export type Device = { id:string; sample_id:string; device_address:string; address_scheme:AddressScheme; grid_row:number|null; grid_col:number|null; notes:string|null; created_by:string|null; created_at:string; updated_at:string; updated_by:string|null }
export type DeviceAlias = { id:string; device_id:string; alias_address:string; alias_scheme:AddressScheme; reason:string; confirmed_by:string; confirmed_at:string }
export type MeasurementHistoryEvent = { device_id:string; sample_id:string; device_address:string; event_kind:'measurement'; event_id:string; occurred_at:string|null; detail:string|null; verdict:null; source:string|null; run_id:null }
export type BenchCellHistoryEvent = { device_id:string; sample_id:string; device_address:string; event_kind:'bench_cell'; event_id:string; occurred_at:string|null; detail:string|null; verdict:BenchVerdict|null; source:string|null; run_id:string|null }
export type DeviceHistoryEvent = MeasurementHistoryEvent|BenchCellHistoryEvent
export type VerdictChange = { dut_id:string; grid_row:number; grid_col:number; device_address:string; prev_verdict:BenchVerdict; new_verdict:BenchVerdict; prev_run_id:string; run_id:string; prev_started_at:string; started_at:string; cause:string|null; direction:'degraded'|'recovered'|'changed' }

type DeviceWrite = { sample_id:string; device_address:string; notes?:string|null }
type AliasWrite = { alias_address:string; alias_scheme:AddressScheme; reason:string }
// Must match SORT_KEYS in api/_lib/resources/devices.js exactly. A stale client list makes a URL
// claim an ordering that the server silently replaces with its default.
export const DEVICE_SORT_KEYS = ['device_address','address_scheme','grid_row','grid_col','created_at','updated_at'] as const
export type DeviceSortKey = typeof DEVICE_SORT_KEYS[number]
export const asDeviceSortKey = (value:string|undefined):DeviceSortKey|undefined => DEVICE_SORT_KEYS.includes(value as DeviceSortKey)?value as DeviceSortKey:undefined
type DeviceQuery = { sample_id?:string; address_scheme?:AddressScheme; q?:string; sort?:DeviceSortKey; order?:'asc'|'desc'; limit?:number; offset?:number }
type HistoryQuery = { from?:string; to?:string; event_kind?:DeviceHistoryEvent['event_kind']; limit?:number; offset?:number }
// Must match VERDICT_SORT_KEYS in api/_lib/resources/devices.js exactly -- pinned by a parity
// test that reads the server's list from source.
export const VERDICT_SORT_KEYS = ['started_at','device_address','dut_id','direction','new_verdict','prev_verdict','run_id','prev_run_id'] as const
export type VerdictSortKey = typeof VERDICT_SORT_KEYS[number]
export const asVerdictSortKey = (value:string|undefined):VerdictSortKey|undefined => VERDICT_SORT_KEYS.includes(value as VerdictSortKey)?value as VerdictSortKey:undefined
type VerdictChangeQuery = { dut_id?:string; direction?:VerdictChange['direction']; from?:string; to?:string; sort?:VerdictSortKey; order?:'asc'|'desc'; limit?:number; offset?:number }
type ApiError = Error & { code?:string; details?:unknown }
const apiBase=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'')
async function fail(response:Response){if(response.ok)return response;const body=await response.json().catch(()=>null) as {error?:{code?:string;message?:string;details?:unknown}}|null;throw Object.assign(new Error(body?.error?.message??`Request failed (${response.status})`),{code:body?.error?.code??'request_failed',details:body?.error?.details}) as ApiError}
async function request<T>(path:string,init:RequestInit={}):Promise<T>{const response=await fetch(`${apiBase}/api${path}`,{credentials:'include',headers:{'Content-Type':'application/json',...init.headers},...init});await fail(response);return response.status===204?undefined as T:response.json() as Promise<T>}
const queryString=(params:Record<string,string|number|undefined>)=>{const query=new URLSearchParams();for(const [key,value] of Object.entries(params))if(value!==undefined&&value!=='')query.set(key,String(value));const text=query.toString();return text?`?${text}`:''}
export const schemeExplanation=(scheme:AddressScheme,row:number|null,col:number|null)=>scheme==='bench_grid'?`Bench grid address: row ${row ?? 'not recorded'}, column ${col ?? 'not recorded'}. These coordinates come from the bench cell and identify D${row}_${col} exactly.`:'Vault label address: this label has no grid coordinates because the vault address carries no die geometry. It is kept literal and is not inferred to be a bench cell.'
export const aliasSummary=(alias:DeviceAlias)=>`${alias.alias_address} (${alias.alias_scheme}) was confirmed by ${alias.confirmed_by}: ${alias.reason}`
export const orderHistoryOldestFirst=(events:DeviceHistoryEvent[])=>[...events].sort((left,right)=>(left.occurred_at??'').localeCompare(right.occurred_at??'')||left.event_id.localeCompare(right.event_id))
export const groupHistoryByDay=(events:DeviceHistoryEvent[])=>{const groups=new Map<string,DeviceHistoryEvent[]>();for(const event of orderHistoryOldestFirst(events)){const day=event.occurred_at?.slice(0,10)??'Date not recorded';groups.set(day,[...(groups.get(day)??[]),event])}return [...groups].map(([day,items])=>({day,items}))}

export async function listDevices(params:DeviceQuery={}):Promise<{items:Device[];total:number}>{return request<{items:Device[];total:number}>(`/devices${queryString(params)}`)}
export async function getDevice(id:string):Promise<{device:Device;aliases:DeviceAlias[];counts:{measurements:number;bench_cells:number}}>{return request(`/devices/${encodeURIComponent(id)}`)}
export async function createDevice(payload:DeviceWrite):Promise<Device>{return (await request<{device:Device}>('/devices',{method:'POST',body:JSON.stringify(payload)})).device}
export async function listDeviceHistory(id:string,params:HistoryQuery={}):Promise<{items:DeviceHistoryEvent[];total:number}>{return request<{items:DeviceHistoryEvent[];total:number}>(`/devices/${encodeURIComponent(id)}/history${queryString(params)}`)}
export async function createDeviceAlias(id:string,payload:AliasWrite):Promise<DeviceAlias>{return (await request<{alias:DeviceAlias}>(`/devices/${encodeURIComponent(id)}/aliases`,{method:'POST',body:JSON.stringify(payload)})).alias}
export async function deleteDeviceAlias(id:string,aliasId:string):Promise<void>{await request(`/devices/${encodeURIComponent(id)}/aliases/${encodeURIComponent(aliasId)}`,{method:'DELETE'})}
export async function registerBenchDevices(dut_id:string):Promise<{created:number}>{return request<{created:number}>('/devices/register-bench',{method:'POST',body:JSON.stringify({dut_id})})}
export async function listVerdictChanges(params:VerdictChangeQuery={}):Promise<{items:VerdictChange[];total:number}>{return request<{items:VerdictChange[];total:number}>(`/verdict-changes${queryString(params)}`)}
