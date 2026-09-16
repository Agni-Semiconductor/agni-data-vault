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

/** A DUT available from the bench database. */
export interface BenchDut { dut_id: string; }
/** A read-only bench campaign row. */
export interface BenchRun { id: number; run_id: string; dut_id: string; name: string; kind: string | null; status: string; operator: string | null; visit_order: string | null; seed: number | null; sample_stride: number; start_index: number; cell_limit: number | null; n_planned: number | null; instrument_source: string | null; instrument: string | null; module: string | null; module_sha256: string | null; board_config: string | null; config_sha256: string | null; safety_sha256: string | null; settle_ms: number | null; quarantine: string | null; params: Record<string, unknown>; thresholds: Record<string, unknown>; manifest: Record<string, unknown>; n_measured: number; n_skipped: number; n_error: number; counts: Record<string, number>; resumed_from: string | null; slack_channel: string | null; slack_thread_ts: string | null; started_at: string | null; completed_at: string | null; created_at: string; }
/** A versioned analysis summary for a bench campaign. */
export interface BenchRunAnalysis { dut_id: string; run_id: string; primary_measurement: string | null; n_dciv: number | null; n_aciv: number | null; best_cell: Record<string, unknown> | null; counts: Record<string, number>; worst_lines: Record<string, unknown> | null; ec_minus: Record<string, unknown> | null; ec_plus: Record<string, unknown> | null; onoff: Record<string, unknown> | null; vread: Record<string, unknown> | null; summary: Record<string, unknown> | null; extractor_version: string; analysed_at: string; }
/** One of the five coverage classes served by the bench API. */
export type VerdictCode = 0 | 1 | 2 | 3 | 4;
/** Packed latest-attempt coverage for a bench campaign. */
export interface BenchCoverage { dut_id: string; run_id: string; rows: number; cols: number; total: number; counts: Record<string, number>; cells: Array<[number, number, number]>; legend: Record<string, string>; colors: { light: Record<string, string>; dark: Record<string, string> }; verdict_codes: Record<string, VerdictCode>; }
/** A device-test row from a bench campaign. */
export interface BenchCell { id: number; dut_id: string; run_id: string; seq: number | null; grid_row: number; grid_col: number; row_relay: string | null; col_relay: string | null; status: 'measured' | 'skipped' | 'error'; verdict: 'normal' | 'short' | 'open' | 'no_signal' | 'indeterminate' | null; cause: string | null; quarantined_by: string | null; suspect: boolean; capture_id: string | null; i_max_a: number | null; i_at_vread_a: number | null; r_low_bias_ohm: number | null; v_first_limit: number | null; frac_limit: number | null; compliance_hit: boolean | null; n_points: number | null; elapsed_s: number | null; metrics: Record<string, unknown>; error: string | null; started_at: string | null; ended_at: string | null; created_at: string; measurement: string; }
/** Persisted analysis metrics for one bench capture. */
export interface BenchAnalysisCell { dut_id: string; run_id: string; capture: string; kind: string | null; row: number | null; col: number | null; cell: string | null; relays: string | null; verdict: string | null; n_points: number | null; onoff: number | null; vread: number | null; ec_plus: number | null; ec_minus: number | null; ec_minus_strength: number | null; ec_minus_lo: number | null; ec_minus_hi: number | null; n_cycles: number | null; n_cycles_resolved: number | null; noise_floor_a: number | null; skipped: string | null; }
/** Failure-rate aggregate for one independent word or bit line. */
export interface BenchLineRate { line: number; measured: number; bad: number; rate: number | null; }
