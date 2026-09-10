import type { PanelSpec as ResolvePanelSpec, TraceSpec as ResolveTraceSpec } from '../plot/resolveTraces'
import type { KindsResponse } from '../plot/units'

export type TraceSpec = ResolveTraceSpec & Record<string, unknown>
export type PanelSpec = ResolvePanelSpec & { traces: TraceSpec[]; annotations?: unknown[]; [key: string]: unknown }
export type FigureSpec = { layout?: string; panels: PanelSpec[]; [key: string]: unknown }
export type Figure = { id:string; slug:string|null; title:string; description:string|null; spec:FigureSpec; pinned_extractor_version:string|null; created_by:string|null; updated_by:string|null; created_at:string; updated_at:string }
export type FigureSource = { figure_id:string; title:string; panel_index:number; trace_index:number; file_id:string|null; capture_id:string|null; label:string|null; source_exists:boolean }

type FigureWrite = Pick<Figure,'title'|'spec'> & Partial<Pick<Figure,'description'|'slug'|'pinned_extractor_version'>>
// The SAME allow-list the API enforces in figures.js's SORT_KEYS. Exported because the caller
// gets its sort key from the URL, where anyone can type anything: `parseSort` returns null for
// an unknown key and the server quietly falls back to updated_at desc, so an unvalidated key
// leaves the table showing a sort indicator on a column the server did not sort by. Nothing
// errors -- the rows are simply in a different order than the header claims.
export const FIGURE_SORT_KEYS = ['title', 'slug', 'created_by', 'created_at', 'updated_at'] as const
export type FigureSortKey = typeof FIGURE_SORT_KEYS[number]
export const asFigureSortKey = (value: string | undefined): FigureSortKey | undefined =>
  FIGURE_SORT_KEYS.includes(value as FigureSortKey) ? value as FigureSortKey : undefined
type FigureQuery = { q?:string; created_by?:string; sort?:FigureSortKey; order?:'asc'|'desc'; limit?:number; offset?:number }
type ApiError = Error & { code?:string; details?:unknown }
const apiBase=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'')
async function fail(response:Response){if(response.ok)return response;const body=await response.json().catch(()=>null) as {error?:{code?:string;message?:string;details?:unknown}}|null;throw Object.assign(new Error(body?.error?.message??`Request failed (${response.status})`),{code:body?.error?.code??'request_failed',details:body?.error?.details}) as ApiError}
async function request<T>(path:string,init:RequestInit={}):Promise<T>{const response=await fetch(`${apiBase}/api${path}`,{credentials:'include',headers:{'Content-Type':'application/json',...init.headers},...init});await fail(response);return response.status===204?undefined as T:response.json() as Promise<T>}

export async function listFigures(params:FigureQuery={}):Promise<{items:Figure[];total:number}>{const query=new URLSearchParams();if(params.q)query.set('q',params.q);if(params.created_by)query.set('created_by',params.created_by);if(params.sort)query.set('sort',params.sort);if(params.order)query.set('order',params.order);if(params.limit!==undefined)query.set('limit',String(params.limit));if(params.offset!==undefined)query.set('offset',String(params.offset));const suffix=query.toString();return request<{items:Figure[];total:number}>(`/figures${suffix?`?${suffix}`:''}`)}
export async function getFigure(idOrSlug:string):Promise<{figure:Figure;sources:FigureSource[]}>{return request<{figure:Figure;sources:FigureSource[]}>(`/figures/${encodeURIComponent(idOrSlug)}`)}
export async function createFigure(payload:FigureWrite):Promise<Figure>{return (await request<{figure:Figure}>('/figures',{method:'POST',body:JSON.stringify(payload)})).figure}
export async function updateFigure(idOrSlug:string,payload:Partial<FigureWrite>):Promise<Figure>{return (await request<{figure:Figure}>(`/figures/${encodeURIComponent(idOrSlug)}`,{method:'PATCH',body:JSON.stringify(payload)})).figure}
export async function deleteFigure(idOrSlug:string):Promise<void>{await request(`/figures/${encodeURIComponent(idOrSlug)}`,{method:'DELETE'})}
export async function getKinds():Promise<KindsResponse>{return request<KindsResponse>('/kinds')}
