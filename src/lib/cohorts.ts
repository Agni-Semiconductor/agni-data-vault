export type CohortGroup = { group_value:string|null; n_members:number; n_with_metric:number; n_no_metric_row:number; n_refused:number; status_confirmed:number; status_assumed:number; status_unknown:number; status_unspecified:number; min_value:number|null; q1:number|null; median:number|null; q3:number|null; max_value:number|null; mean:number|null; stddev:number|null }
export type GroupKey = { key:string; label:string; entity:'sample'|'measurement'; status_key:string|null; value_kind:'categorical'|'continuous'; unit:string|null; notes:string|null }
export type MetricDefinition = { metric:string; label:string; unit:string|null; log_scale:boolean; notes:string|null }
export type Cohort = { id:string; slug:string|null; name:string; description:string|null; predicate:Record<string,unknown>; metric:string|null; group_by:string|null; extractor_version:string|null; created_by:string|null; updated_by:string|null; created_at:string; updated_at:string }

type CohortWrite = Pick<Cohort,'name'|'predicate'> & Partial<Pick<Cohort,'description'|'slug'|'metric'|'group_by'|'extractor_version'>>
// Must match SORT_KEYS in api/_lib/resources/cohorts.js exactly -- pinned by
// tests/figuresClient.test.ts, which reads the server's list from source. It caught this list
// missing `metric` and `group_by`: the API accepted them, the client's type rejected them, so
// the UI silently could not offer two sorts that already worked.
export const COHORT_SORT_KEYS = ['name','slug','metric','group_by','created_by','created_at','updated_at'] as const
export type CohortSortKey = typeof COHORT_SORT_KEYS[number]
export const asCohortSortKey = (value:string|undefined):CohortSortKey|undefined => COHORT_SORT_KEYS.includes(value as CohortSortKey)?value as CohortSortKey:undefined
type CohortQuery = { q?:string; sort?:CohortSortKey; order?:'asc'|'desc'; limit?:number; offset?:number }
export type CohortSummary = { groups:CohortGroup[]; total_members:number; excluded:number }
type SummaryRequest = { predicate:Record<string,unknown>; metric:string; group_by:string; extractor_version?:string|null } | { cohort_id:string }
type ApiError = Error & { code?:string; details?:unknown }
const apiBase=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'')
async function fail(response:Response){if(response.ok)return response;const body=await response.json().catch(()=>null) as {error?:{code?:string;message?:string;details?:unknown}}|null;throw Object.assign(new Error(body?.error?.message??`Request failed (${response.status})`),{code:body?.error?.code??'request_failed',details:body?.error?.details}) as ApiError}
async function request<T>(path:string,init:RequestInit={}):Promise<T>{const response=await fetch(`${apiBase}/api${path}`,{credentials:'include',headers:{'Content-Type':'application/json',...init.headers},...init});await fail(response);return response.status===204?undefined as T:response.json() as Promise<T>}

export async function getCohortKeys():Promise<{group_keys:GroupKey[];metrics:MetricDefinition[]}>{return request<{group_keys:GroupKey[];metrics:MetricDefinition[]}>('/cohort-keys')}
export async function listCohorts(params:CohortQuery={}):Promise<{items:Cohort[];total:number}>{const query=new URLSearchParams();if(params.q)query.set('q',params.q);if(params.sort)query.set('sort',params.sort);if(params.order)query.set('order',params.order);if(params.limit!==undefined)query.set('limit',String(params.limit));if(params.offset!==undefined)query.set('offset',String(params.offset));const suffix=query.toString();return request<{items:Cohort[];total:number}>(`/cohorts${suffix?`?${suffix}`:''}`)}
export async function getCohort(idOrSlug:string):Promise<Cohort>{return (await request<{cohort:Cohort}>(`/cohorts/${encodeURIComponent(idOrSlug)}`)).cohort}
export async function createCohort(payload:CohortWrite):Promise<Cohort>{return (await request<{cohort:Cohort}>('/cohorts',{method:'POST',body:JSON.stringify(payload)})).cohort}
export async function updateCohort(idOrSlug:string,payload:Partial<CohortWrite>):Promise<Cohort>{return (await request<{cohort:Cohort}>(`/cohorts/${encodeURIComponent(idOrSlug)}`,{method:'PATCH',body:JSON.stringify(payload)})).cohort}
export async function deleteCohort(idOrSlug:string):Promise<void>{await request(`/cohorts/${encodeURIComponent(idOrSlug)}`,{method:'DELETE'})}
export async function cohortSummary(payload:SummaryRequest):Promise<CohortSummary>{return request<CohortSummary>('/cohorts/summary',{method:'POST',body:JSON.stringify(payload)})}
