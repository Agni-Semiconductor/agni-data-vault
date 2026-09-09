/** Supported record entities. */
export type Entity = 'sample' | 'measurement' | 'file';
/** Supported configurable metadata field types. */
export type FieldType = 'text'|'longtext'|'number'|'integer'|'date'|'bool'|'select'|'multiselect'|'person'|'layer_stack'|'json';
/** Confidence assigned to metadata. */
export type MetaStatus = 'confirmed' | 'assumed' | 'unknown';
/** A field-definition row. */
export interface FieldDef { id: string; entity: Entity; key: string; label: string; help: string | null; type: FieldType; options_list_key: string | null; unit: string | null; required: boolean; sort_order: number; group_name: string | null; active: boolean; column_name: string | null; show_in_table: boolean; filterable: boolean; min: number | null; max: number | null; regex: string | null; default_value: unknown; created_at: string; updated_at: string; }
/** A value within an option list. */
export interface OptionValue { id: string; list_key: string; value: string; label: string; sort_order: number; active: boolean; meta: Record<string, unknown>; }
/** A named vocabulary and its values. */
export interface OptionList { key: string; label: string; description: string | null; values: OptionValue[]; }
/** A role in a sample's material stack. */
export type LayerRole = 'substrate'|'bottom_metal'|'il_bot'|'fe'|'il_top'|'top_metal'|'other';
/** One material-stack layer. */
export interface StackLayer { role: LayerRole; material: string; t_nm: number | null; notes?: string; }
/** A fabricated sample. */
export interface Sample { id: string; sample_id: string; label: string | null; family: string | null; owner: string | null; substrate: string | null; substrate_size: string | null; fab_location: string | null; fabricated_by: string | null; fabricated_on: string | null; stack: StackLayer[]; meta: Record<string, unknown>; meta_status: Record<string, MetaStatus>; notes: string | null; created_by: string | null; created_at: string; updated_at: string; }
/** A measurement session. */
export interface Measurement { id: string; sample_id: string; measured_on: string | null; kind: string | null; instrument: string | null; probe_station: string | null; measured_by: string | null; temperature_c: number | null; device_address: string | null; run_numbers: number[]; pad_shape: 'circle'|'square'|null; pad_dim_um: number | null; pad_area_override: number | null; pad_area_um2: number | null; meta: Record<string, unknown>; meta_status: Record<string, MetaStatus>; notes: string | null; created_by: string | null; created_at: string; updated_at: string; }
/** State of a file upload. */
export type UploadState = 'pending' | 'ready' | 'failed';
/** A vault file. */
export interface VaultFile { id: string; measurement_id: string; storage_path: string; original_name: string; kind: string; size_bytes: number | null; sha256: string | null; parsed: Record<string, unknown>; upload_state: UploadState; created_by: string | null; created_at: string; }
/** A listable entity row. */
export type EntityRow = Sample | Measurement;
/** Paginated list response. */
export interface ListResult<T> { items: T[]; total: number; }
