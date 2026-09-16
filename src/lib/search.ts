export type SearchEntity = 'sample'|'measurement'|'device'|'cohort'
export type SearchFilterValue = string|number|boolean
export type SearchFilterResult = { url:string; entity:SearchEntity; filters:Record<string,SearchFilterValue>; explanation:string; unknown_terms:string[]; query_id:string|null }
export type SearchRefusalResult = { refusal:string; unknown_terms:string[]; query_id:string|null }
export type AskSearchResult = SearchFilterResult|SearchRefusalResult
export type SearchHistoryItem = { id:string; question:string; filters:Record<string,SearchFilterValue>|null; result_url:string|null; entity:SearchEntity|null; refusal:string|null; unknown_terms:string[]; model:string|null; latency_ms:number|null; input_tokens:number|null; output_tokens:number|null; accepted:boolean|null; asked_by:string|null; asked_at:string }
export type SearchHistoryQuery = { q?:string; refused?:boolean; limit?:number; offset?:number }
export type SearchApiError = Error & { code?:string; details?:unknown }

const apiBase=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'')
async function fail(response:Response){if(response.ok)return response;const body=await response.json().catch(()=>null) as {error?:{code?:string;message?:string;details?:unknown}}|null;throw Object.assign(new Error(body?.error?.message??`Request failed (${response.status})`),{code:body?.error?.code??'request_failed',details:body?.error?.details}) as SearchApiError}
async function request<T>(path:string,init:RequestInit={}):Promise<T>{const response=await fetch(`${apiBase}/api${path}`,{credentials:'include',headers:{'Content-Type':'application/json',...init.headers},...init});await fail(response);return response.status===204?undefined as T:response.json() as Promise<T>}

export async function askSearch(question:string):Promise<AskSearchResult>{return request<AskSearchResult>('/search/ask',{method:'POST',body:JSON.stringify({question})})}
export async function acceptSearch(queryId:string):Promise<{ok:true}>{return request<{ok:true}>(`/search/${encodeURIComponent(queryId)}/accepted`,{method:'POST'})}
export async function listSearchHistory(params:SearchHistoryQuery={}):Promise<{items:SearchHistoryItem[];total:number}>{const query=new URLSearchParams();if(params.q)query.set('q',params.q);if(params.refused!==undefined)query.set('refused',params.refused?'1':'0');if(params.limit!==undefined)query.set('limit',String(params.limit));if(params.offset!==undefined)query.set('offset',String(params.offset));const suffix=query.toString();return request<{items:SearchHistoryItem[];total:number}>(`/search/history${suffix?`?${suffix}`:''}`)}
