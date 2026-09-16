#!/usr/bin/env node
// Copies the hosted public-schema vault into the self-hosted vault schema without ever writing to the source.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_SIZE = 100;
const statePath = resolve(process.cwd(), '.migrate-vault-data.state.json');
const dryRun = !process.argv.slice(2).includes('--apply');

if (process.argv.slice(2).some((arg) => !['--dry-run', '--apply', '--help', '-h'].includes(arg))) fail('usage: node scripts/migrate-vault-data.mjs [--dry-run|--apply]');
if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
  console.log(`Usage: node scripts/migrate-vault-data.mjs [--dry-run|--apply]

Copies hosted vault rows and verified ready objects into the self-hosted vault.
--dry-run is the default: it writes NOTHING to storage, either database, or the state file. Use --apply to write.
The state file records completed work so an interrupted run resumes; source endpoints are GET-only.`);
  process.exit(0);
}

const required = ['SOURCE_REST_URL', 'SOURCE_SERVICE_KEY', 'VAULT_REST_URL', 'VAULT_SERVICE_JWT', 'SOURCE_STORAGE_URL', 'VAULT_STORAGE_URL'];
for (const name of required) if (!process.env[name]) fail(`${name} environment variable must be set`);

// This order satisfies foreign keys; reversing it produces constraint errors that look like missing source data.
const tables = [
  { name: 'option_lists', key: 'key' },
  { name: 'option_values', key: 'id' },
  { name: 'field_definitions', key: 'id' },
  { name: 'samples', key: 'id' },
  { name: 'measurements', key: 'id' },
  { name: 'files', key: 'id' },
  { name: 'allowlist', key: 'email' },
];
// audit_log is intentionally excluded: destination INSERT triggers create audit rows and the supplied REST wire has no
// sequence-reset RPC, so preserving source IDs would collide and omitting IDs would make resume duplicate history.

const summary = Object.fromEntries([...tables.map(({ name }) => [name, counts()]), ['objects', counts()]]);
const warnings = { pending: 0, failed: 0, nullSha256: 0 };
let state = loadState();

// A completed marker avoids touching either endpoint on a re-run; re-copying would turn a success into noisy conflicts.
if (state.completed) {
  console.log('Migration already completed; no work performed.');
  printSummary();
  process.exit(0);
}

try {
  const sourceRows = new Map();
  for (const table of tables) sourceRows.set(table.name, await listSource(table));
  // Snapshot before any destination write; otherwise a ready file inserted during object copying can leave a dangling row.
  await migrateObjects(sourceRows.get('files'));
  for (const table of tables) await migrateTable(table, sourceRows.get(table.name));
  state.completed = true;
  saveState();
  printSummary();
} catch (error) {
  printSummary();
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
}

function counts() { return { copied: 0, skipped: 0, failed: 0 }; }

function loadState() {
  if (!existsSync(statePath)) return { objects: {}, tables: {} };
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return { objects: parsed.objects ?? {}, tables: parsed.tables ?? {}, completed: parsed.completed === true };
  } catch (error) {
    fail(`cannot read state file ${statePath}: ${error.message}`);
  }
}

function saveState() {
  if (dryRun) return;
  // Rename makes each checkpoint atomic; a direct write can leave truncated JSON that misleadingly looks like no prior progress.
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
}

function restUrl(base, table, params = {}) {
  const url = new URL(`${base.replace(/\/$/, '')}/${encodeURIComponent(table)}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function objectUrl(base, bucket, storagePath) {
  // Encode segments separately; encoding the whole path turns '/' into data and yields an object-not-found symptom.
  return `${base.replace(/\/$/, '')}/storage/v1/object/${encodeURIComponent(bucket)}/${String(storagePath).split('/').map(encodeURIComponent).join('/')}`;
}

function sourceHeaders() { return { apikey: process.env.SOURCE_SERVICE_KEY, Authorization: `Bearer ${process.env.SOURCE_SERVICE_KEY}` }; }
function destinationHeaders(profile = false) {
  return { Authorization: `Bearer ${process.env.VAULT_SERVICE_JWT}`, ...(profile ? { 'Content-Profile': 'vault' } : { 'Accept-Profile': 'vault' }) };
}

async function request(url, options, label) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  return response;
}

async function listSource(table) {
  const result = [];
  let last = null;
  while (true) {
    const params = { select: '*', order: `${table.key}.asc`, limit: String(PAGE_SIZE) };
    if (last !== null) params[table.key] = `gt.${last}`;
    // Keyset paging cannot skip rows when inserts shift offsets; offset paging can falsely report a complete migration.
    const response = await request(restUrl(process.env.SOURCE_REST_URL, table.name, params), { headers: sourceHeaders() }, `source ${table.name} page`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`source ${table.name} did not return a JSON array`);
    result.push(...page);
    if (page.length < PAGE_SIZE) return result;
    last = page.at(-1)?.[table.key];
    if (last == null) throw new Error(`source ${table.name} page lacks ${table.key} required for keyset paging`);
  }
}

async function migrateObjects(files) {
  for (const file of files) {
    if (file.sha256 == null) {
      warnings.nullSha256 += 1;
      console.error(`WARN files/${file.id}: sha256 is null; preserving it because null permits distinct duplicate rows.`);
    }
    if (file.upload_state === 'pending' || file.upload_state === 'failed') {
      warnings[file.upload_state] += 1;
      summary.objects.skipped += 1;
      console.error(`WARN files/${file.id}: ${file.upload_state} upload has no trustworthy object; row will still be preserved.`);
      continue;
    }
    if (file.upload_state !== 'ready') throw new Error(`files/${file.id} has unknown upload_state ${JSON.stringify(file.upload_state)}`);
    const bucket = file.bucket ?? 'vault';
    const objectKey = `${bucket}/${file.storage_path}`;
    if (state.objects[objectKey]) { summary.objects.skipped += 1; continue; }
    if (dryRun) { summary.objects.skipped += 1; console.log(`DRY RUN object ${objectKey}`); continue; }
    try {
      const source = await request(objectUrl(process.env.SOURCE_STORAGE_URL, bucket, file.storage_path), { headers: sourceHeaders() }, `source object ${objectKey}`);
      const bytes = Buffer.from(await source.arrayBuffer());
      const sourceHash = sha256(bytes);
      if (file.sha256 != null && sourceHash !== file.sha256) throw new Error(`source sha256 ${sourceHash} does not match recorded ${file.sha256}`);
      const destination = await fetch(objectUrl(process.env.VAULT_STORAGE_URL, bucket, file.storage_path), { headers: destinationHeaders() });
      let uploaded = false;
      if (destination.status === 404) {
        // x-upsert=false refuses replacement; overwriting a mismatched existing object would conceal corruption.
        await request(objectUrl(process.env.VAULT_STORAGE_URL, bucket, file.storage_path), { method: 'POST', headers: { ...destinationHeaders(), 'content-type': source.headers.get('content-type') ?? 'application/octet-stream', 'x-upsert': 'false' }, body: bytes }, `destination object ${objectKey}`);
        uploaded = true;
      } else if (!destination.ok) {
        throw new Error(`destination object ${objectKey} returned HTTP ${destination.status}: ${(await destination.text()).slice(0, 1000)}`);
      }
      // Re-download instead of trusting length; equal-length truncation misleadingly passes a size check.
      const verified = await request(objectUrl(process.env.VAULT_STORAGE_URL, bucket, file.storage_path), { headers: destinationHeaders() }, `verify destination object ${objectKey}`);
      const destinationHash = sha256(Buffer.from(await verified.arrayBuffer()));
      if (destinationHash !== sourceHash) throw new Error(`destination sha256 ${destinationHash} does not match source ${sourceHash}`);
      state.objects[objectKey] = true;
      saveState();
      summary.objects[uploaded ? 'copied' : 'skipped'] += 1;
    } catch (error) {
      summary.objects.failed += 1;
      throw error;
    }
  }
}

async function migrateTable(table, rows) {
  let last = state.tables[table.name] ?? null;
  for (const row of rows) {
    if (last !== null && String(row[table.key]) <= String(last)) continue;
      try {
        if (dryRun) { summary[table.name].skipped += 1; console.log(`DRY RUN row ${table.name}/${row[table.key]}`); }
        else await insertIfAbsent(table, row);
        last = row[table.key];
        state.tables[table.name] = last;
        saveState();
      } catch (error) {
        summary[table.name].failed += 1;
        throw error;
      }
  }
}

async function insertIfAbsent(table, row) {
  const value = row[table.key];
  const existing = await request(restUrl(process.env.VAULT_REST_URL, table.name, { select: '*', [table.key]: `eq.${value}`, limit: '1' }), { headers: destinationHeaders() }, `destination ${table.name} lookup`);
  const rows = await existing.json();
  if (!Array.isArray(rows)) throw new Error(`destination ${table.name} lookup did not return a JSON array`);
  if (rows.length) {
    // Compare source columns only: destination-generated columns would otherwise falsely report a divergent row.
    if (!sameSourceColumns(row, rows[0])) throw new Error(`destination ${table.name}/${value} differs from source; refusing to overwrite it`);
    summary[table.name].skipped += 1;
    return;
  }
  // Insert-only is deliberately not an upsert: an existing divergent row must fail loudly, not be silently rewritten.
  await request(restUrl(process.env.VAULT_REST_URL, table.name), { method: 'POST', headers: { ...destinationHeaders(true), 'content-type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(row) }, `destination ${table.name} insert`);
  summary[table.name].copied += 1;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function sameSourceColumns(source, destination) {
  // Sort JSON keys before comparison because object-key order has no database meaning but can misleadingly differ in JSON text.
  return stableJson(source) === stableJson(Object.fromEntries(Object.keys(source).map((key) => [key, destination[key]])));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function printSummary() {
  for (const [name, count] of Object.entries(summary)) console.log(`${name}: copied=${count.copied} skipped=${count.skipped} failed=${count.failed}`);
  console.log(`files classified: pending=${warnings.pending} failed=${warnings.failed} sha256_null=${warnings.nullSha256}`);
}

function fail(message) { console.error(message); process.exit(2); }
