import type { BenchAnalysisCell, BenchCell, BenchCoverage, BenchDut, BenchLineRate, BenchRun, BenchRunAnalysis, ListResult } from './types'

type ApiError = Error & { code?: string; details?: unknown }
type RunParams = { dutId: string; status?: string; limit?: number; offset?: number }
type CellParams = { dutId: string; runId: string; verdict?: string; status?: string; measurement?: string; rowMin?: number; rowMax?: number; colMin?: number; colMax?: number; sort?: keyof BenchCell; order?: 'asc' | 'desc'; limit?: number; offset?: number }
type AnalysisCellParams = { dutId: string; runId: string; limit?: number; offset?: number }
type BenchLines = { rows: BenchLineRate[]; cols: BenchLineRate[]; ramp: { light: string[]; dark: string[] } }
const apiBase=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'')
async function fail(response:Response){if(response.ok)return response;const body=await response.json().catch(()=>null) as {error?:{code?:string;message?:string;details?:unknown}}|null;throw Object.assign(new Error(body?.error?.message??`Request failed (${response.status})`),{code:body?.error?.code??'request_failed',details:body?.error?.details}) as ApiError}
async function request<T>(path:string):Promise<T>{const response=await fetch(`${apiBase}/api${path}`,{credentials:'include',headers:{'Content-Type':'application/json'}});await fail(response);return response.json() as Promise<T>}
function query(values:Record<string,string|number|undefined>){const params=new URLSearchParams();for(const [key,value] of Object.entries(values))if(value!==undefined&&value!=='')params.set(key,String(value));const result=params.toString();return result?`?${result}`:''}
export async function listBenchDuts():Promise<ListResult<BenchDut>>{return request<ListResult<BenchDut>>('/bench/duts')}
export async function listBenchRuns(params:RunParams):Promise<ListResult<BenchRun>>{return request<ListResult<BenchRun>>(`/bench/runs${query({dut_id:params.dutId,status:params.status,limit:params.limit,offset:params.offset})}`)}
export async function getBenchRun(runId:string,dutId:string):Promise<{run:BenchRun;analysis:BenchRunAnalysis|null}>{return request<{run:BenchRun;analysis:BenchRunAnalysis|null}>(`/bench/runs/${encodeURIComponent(runId)}${query({dut_id:dutId})}`)}
export async function getBenchCoverage(dutId:string,runId:string):Promise<BenchCoverage>{return request<BenchCoverage>(`/bench/coverage${query({dut_id:dutId,run_id:runId})}`)}
export async function listBenchCells(params:CellParams):Promise<ListResult<BenchCell>>{return request<ListResult<BenchCell>>(`/bench/cells${query({dut_id:params.dutId,run_id:params.runId,verdict:params.verdict,status:params.status,measurement:params.measurement,row_min:params.rowMin,row_max:params.rowMax,col_min:params.colMin,col_max:params.colMax,sort:params.sort,order:params.order,limit:params.limit,offset:params.offset})}`)}
export async function listBenchAnalysisCells(params:AnalysisCellParams):Promise<ListResult<BenchAnalysisCell>>{return request<ListResult<BenchAnalysisCell>>(`/bench/analysis/cells${query({dut_id:params.dutId,run_id:params.runId,limit:params.limit,offset:params.offset})}`)}
export async function getBenchLines(dutId:string,runId:string):Promise<BenchLines>{return request<BenchLines>(`/bench/lines${query({dut_id:dutId,run_id:runId})}`)}
export function benchCaptureUrl(captureId:string,dutId:string):string{return `${apiBase}/api/bench/captures/${encodeURIComponent(captureId)}/content${query({dut_id:dutId})}`}
