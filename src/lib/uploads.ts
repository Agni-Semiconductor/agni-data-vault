export type EvidenceValue={value:unknown;class:'E2'|'E3'|'human';source:string}
export type QueuedCandidate={field:string;candidate_value:unknown;reason:string;evidence_seen:EvidenceValue[]}
export type UploadGroup={key:string;folder:string;run_number:number|null;files:string[];confirmed:Record<string,EvidenceValue>;queued:QueuedCandidate[];measured_on?:string;kind?:string}
export type UploadAnalysis={groups:UploadGroup[];totals:{files:number;groups:number;confirmed_fields:number;queued_fields:number};warnings:string[]}
export type ReviewItem={id:string;entity:'sample'|'measurement';entity_id:string;field:string;candidate_value:unknown;reason:string;evidence_seen:EvidenceValue[];status:'open'|'accepted'|'rejected';resolved_by:string|null;resolved_at:string|null;created_by:string|null;created_at:string}

type ApiError=Error&{code?:string;details?:unknown}
export type UploadFile={path:string;size_bytes:number;sha256?:string}
export type CommitGroup={key:string;measured_on?:string;kind?:string;confirmed:Record<string,EvidenceValue>;queued:QueuedCandidate[];files:UploadFile[]}
export type UploadCommit={measurements:Array<{key:string;measurement_id:string;uploads:Array<{path:string;file_id:string;upload_url?:string;duplicate?:boolean}>}>;review_queued:number;warnings:string[]}
type ReviewQuery={status?:ReviewItem['status'];entity?:ReviewItem['entity'];limit?:number;offset?:number}
const apiBase=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'')
async function fail(response:Response){if(response.ok)return response;const body=await response.json().catch(()=>null) as {error?:{code?:string;message?:string;details?:unknown}}|null;throw Object.assign(new Error(body?.error?.message??`Request failed (${response.status})`),{code:body?.error?.code??'request_failed',details:body?.error?.details}) as ApiError}
async function request<T>(path:string,init:RequestInit={}):Promise<T>{const response=await fetch(`${apiBase}/api${path}`,{credentials:'include',headers:{'Content-Type':'application/json',...init.headers},...init});await fail(response);return response.status===204?undefined as T:response.json() as Promise<T>}
export async function analyzeUpload(files:UploadFile[]):Promise<UploadAnalysis>{return request<UploadAnalysis>('/uploads/analyze',{method:'POST',body:JSON.stringify({files})})}
export async function commitUpload(sampleId:string,groups:CommitGroup[]):Promise<UploadCommit>{return request<UploadCommit>('/uploads/commit',{method:'POST',body:JSON.stringify({sample_id:sampleId,groups})})}
export async function listReviewQueue(params:ReviewQuery={}):Promise<{items:ReviewItem[];total:number}>{const query=new URLSearchParams();if(params.status)query.set('status',params.status);if(params.entity)query.set('entity',params.entity);if(params.limit!==undefined)query.set('limit',String(params.limit));if(params.offset!==undefined)query.set('offset',String(params.offset));const suffix=query.toString();return request<{items:ReviewItem[];total:number}>(`/review-queue${suffix?`?${suffix}`:''}`)}
export async function acceptReviewItem(id:string,value?:unknown):Promise<ReviewItem>{return (await request<{item:ReviewItem}>(`/review-queue/${encodeURIComponent(id)}/accept`,{method:'POST',body:JSON.stringify(value===undefined?{}:{value})})).item}
export async function rejectReviewItem(id:string,note?:string):Promise<ReviewItem>{return (await request<{item:ReviewItem}>(`/review-queue/${encodeURIComponent(id)}/reject`,{method:'POST',body:JSON.stringify(note===undefined?{}:{note})})).item}
