import { parseFilename } from './storage.js';

const valueKey = (value) => JSON.stringify(value);
const unique = (items) => [...new Map(items.map((item) => [valueKey(item.value), item])).values()];
const filenameSource = (token) => `filename token "${token}"`;
const folderSource = (segment, levelsUp) => `folder segment "${segment}" (${levelsUp} levels up)`;
const evidenceSeen = (items) => items.map(({ value, class: evidenceClass, source }) => ({ value, class: evidenceClass, source }));
const queue = (field, candidates, reason) => ({ field, candidate_value: candidates.length === 1 ? candidates[0].value : candidates.map(({ value }) => value), reason, evidence_seen: evidenceSeen(candidates) });
const addMatches = (target, field, input, regex, map, evidenceClass, sourceFor) => { const matches = [...input.matchAll(regex)]; for (const match of matches) (target[field] ??= []).push({ value: map(match), class: evidenceClass, source: sourceFor(match) }); };
const resolve = (field, e2 = [], e3 = []) => { const candidates = [...e2, ...e3]; const e2Values = unique(e2); const e3Values = unique(e3); if (e2Values.length > 1) return { queued: queue(field, candidates, `ambiguous E2 ${field} candidates`) }; if (e3Values.length > 1) return { queued: queue(field, candidates, `ambiguous E3 ${field} candidates`) }; if (e2Values[0] && e3Values[0] && valueKey(e2Values[0].value) !== valueKey(e3Values[0].value)) return { queued: queue(field, candidates, `E2 and E3 ${field} values disagree`) }; const confirmed = e2Values[0] ?? e3Values[0]; return confirmed ? { confirmed } : {}; };
const folderParts = (relativePath) => String(relativePath).replace(/\\/g, '/').split('/').filter(Boolean);
const addressMatches = (segment) => (String(segment).match(/[A-Za-z0-9]+/g) ?? []).flatMap((token) => /^[A-Z]\d{1,3}$/i.test(token) ? [token.toUpperCase()] : /^[A-Z]\d{1,3}(?:[A-Z]\d{1,3})+$/i.test(token) ? [...token.matchAll(/[A-Z]\d{1,3}/gi)].map((match) => match[0].toUpperCase()) : []);

export function extractFromPath(relativePath) {
  const parts = folderParts(relativePath); const filename = parts.at(-1) ?? ''; const folders = parts.slice(0, -1); const parsed = parseFilename(filename); const e2 = {}; const e3 = {};
  const runs = [...filename.matchAll(/Run(\d+)/gi)].map((match) => Number(match[1]));
  if (runs.length) e2.run_numbers = [{ value: [...new Set(runs)], class: 'E2', source: filenameSource([...filename.matchAll(/Run\d+/gi)].map((match) => match[0]).join(', ')) }];
  if (parsed.file_date) { const match = filename.match(/(\d{2})-(\d{2})-(\d{4})/); e2.measured_on = [{ value: parsed.file_date, class: 'E2', source: filenameSource(match[0]) }]; }
  if (parsed.detected_kind) { const match = filename.match(/dc[- ]?iv|dciv|\bdc\b|ac[- ]?iv|aciv|hysteresis|\bac\b|pund|\bcv\b|c-v/i); e2.kind = [{ value: parsed.detected_kind, class: 'E2', source: filenameSource(match[0]) }]; }
  addMatches(e2, 'pad_dim_um', filename, /(\d+(?:\.\d+)?)\s*um/gi, (match) => Number(match[1]), 'E2', (match) => filenameSource(match[0]));
  for (const address of addressMatches(filename)) (e2.device_address ??= []).push({ value: address, class: 'E2', source: filenameSource(address) });
  addMatches(e2, 'sweep_v', filename, /(\d+(?:\.\d+)?)\s*v\b/gi, (match) => Number(match[1]), 'E2', (match) => filenameSource(match[0]));
  addMatches(e2, 'frequency_khz', filename, /(\d+(?:\.\d+)?)\s*(k?hz)/gi, (match) => Number(match[1]) / (match[2].toLowerCase() === 'hz' ? 1000 : 1), 'E2', (match) => filenameSource(match[0]));
  folders.forEach((segment, index) => { const levelsUp = folders.length - index; const source = folderSource(segment, levelsUp); if (/^RT$/i.test(segment.trim())) (e3.temperature_c ??= []).push({ value: 25, class: 'E3', source }); addMatches(e3, 'temperature_c', segment, /(\d+)\s*C\b/gi, (match) => Number(match[1]), 'E3', () => source); addMatches(e3, 'pad_dim_um', segment, /(\d+(?:\.\d+)?)\s*um/gi, (match) => Number(match[1]), 'E3', () => source); for (const address of addressMatches(segment)) (e3.device_address ??= []).push({ value: address, class: 'E3', source }); addMatches(e3, 'pulse_width_us', segment, /(\d+(?:\.\d+)?)\s*us\b/gi, (match) => Number(match[1]), 'E3', () => source); });
  const confirmed = {}; const queued = []; for (const field of new Set([...Object.keys(e2), ...Object.keys(e3)])) { const result = resolve(field, e2[field], e3[field]); if (result.confirmed) confirmed[field] = result.confirmed; if (result.queued) queued.push(result.queued); } return { confirmed, queued };
}

export function proposeGroups(files) {
  const groups = new Map();
  for (const file of files) { const relativePath = typeof file === 'string' ? file : file.path; const parts = folderParts(relativePath); const folder = parts.slice(0, -1).join('/'); const extracted = extractFromPath(relativePath); const runs = extracted.confirmed.run_numbers?.value ?? [null]; for (const runNumber of runs) { const key = `${folder || '.'}::${runNumber === null ? 'folder' : `run-${runNumber}`}`; const group = groups.get(key) ?? { key, folder, run_number: runNumber, entries: [] }; group.entries.push({ relativePath, extracted }); groups.set(key, group); } }
  return [...groups.values()].map(({ key, folder, run_number, entries }) => { const confirmed = {}; const queued = []; const fields = new Set(entries.flatMap(({ extracted }) => [...Object.keys(extracted.confirmed), ...extracted.queued.map(({ field }) => field)])); for (const field of fields) { const fieldQueues = entries.flatMap(({ extracted }) => extracted.queued.filter((item) => item.field === field)); const candidates = entries.flatMap(({ extracted }) => extracted.confirmed[field] ? [extracted.confirmed[field]] : []); if (fieldQueues.length) { queued.push(...fieldQueues); continue; } if (field === 'run_numbers' && run_number !== null) { const candidate = candidates.find(({ value }) => value.includes(run_number)); if (candidate) confirmed[field] = { ...candidate, value: [run_number] }; continue; } const values = unique(candidates); if (values.length === 1) confirmed[field] = values[0]; else if (values.length > 1) queued.push(queue(field, candidates, `files in proposed group disagree on ${field}`)); } return { key, folder, run_number, files: [...new Set(entries.map(({ relativePath }) => relativePath))], confirmed, queued }; });
}
