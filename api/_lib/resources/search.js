import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { isUuid, parsePagination } from '../validate.js';
import { likeTerm } from '../query.js';
import { AGENT_MODEL, askModel, buildGrounding, buildUrl, parseModelOutput, requireQuestion, validateFilters } from '../agent.js';

const actorFor = (principal) => principal?.kind === 'human' ? principal.actor : principal?.actor ?? 'api';

/** Record what was asked and what came back. Written on EVERY outcome, including refusals. */
async function record(row) {
  const { data, error } = await supabaseAdmin().from('agent_queries').insert(row).select('id').single();
  // A failed audit write must not swallow the answer the user asked for -- but it must be loud in
  // the log, because an audit trail with silent holes is worse than one that is obviously broken.
  if (error) { console.error('agent_queries insert failed:', error.message); return null; }
  return data?.id ?? null;
}

/**
 * POST /api/search/ask
 *
 * Question -> schema -> filter -> URL. The model never sees a measurement row; see api/_lib/agent.js.
 */
export async function ask(body, principal, client) {
  const question = requireQuestion(body);
  const asked_by = actorFor(principal);
  const started = Date.now();

  const grounding = await buildGrounding();
  let response;
  try {
    response = await askModel(question, grounding, client);
  } catch (error) {
    if (error instanceof ApiError) throw error;      // 503 when unconfigured -- already shaped
    // An upstream failure is recorded as a refusal rather than lost: "it did nothing and I don't
    // know why" is the report that makes a feature untrustworthy.
    const refusal = 'The search agent could not be reached.';
    const query_id = await record({ question, refusal, asked_by, model: AGENT_MODEL, latency_ms: Date.now() - started });
    throw new ApiError(502, 'agent_failed', refusal, [{ key: 'query_id', message: String(query_id) }]);
  }

  const latency_ms = Date.now() - started;
  const usage = { input_tokens: response?.usage?.input_tokens ?? null, output_tokens: response?.usage?.output_tokens ?? null };
  const parsed = parseModelOutput(response);
  if (!parsed.ok) {
    const query_id = await record({ question, refusal: parsed.refusal, asked_by, model: AGENT_MODEL, latency_ms, ...usage });
    return { status: 200, body: { refusal: parsed.refusal, unknown_terms: [], query_id } };
  }

  const answer = parsed.value;
  const unknown_terms = Array.isArray(answer.unknown_terms) ? answer.unknown_terms.filter((t) => typeof t === 'string') : [];

  // The model declining is a FIRST-CLASS OUTCOME, not an error. A question the schema cannot
  // express deserves "I cannot filter on that, here is what I could not map" -- which is more
  // useful than a filter that quietly drops the important half and returns plausible wrong rows.
  if (answer.answerable === false) {
    const refusal = typeof answer.explanation === 'string' && answer.explanation.trim()
      ? answer.explanation.trim()
      : 'This database has no field that answers that question.';
    const query_id = await record({ question, refusal, unknown_terms, asked_by, model: AGENT_MODEL, latency_ms, ...usage });
    return { status: 200, body: { refusal, unknown_terms, query_id } };
  }

  const filters = answer.filters && typeof answer.filters === 'object' && !Array.isArray(answer.filters) ? answer.filters : {};
  const check = validateFilters(filters, grounding.allowed);
  if (!check.ok) {
    // An invented field key is caught HERE, before anything is fetched, and reported rather than
    // dropped. A dropped condition returns rows that look like an answer to a question nobody
    // asked, and nothing downstream could tell.
    const query_id = await record({ question, refusal: check.refusal, unknown_terms: [...unknown_terms, ...check.unknown], asked_by, model: AGENT_MODEL, latency_ms, ...usage });
    return { status: 200, body: { refusal: check.refusal, unknown_terms: [...unknown_terms, ...check.unknown], query_id } };
  }

  const entity = ['sample', 'measurement', 'device', 'cohort'].includes(answer.entity) ? answer.entity : 'sample';
  const extras = {};
  if (typeof answer.q === 'string' && answer.q.trim()) extras.q = likeTerm(answer.q);
  if (typeof answer.sort === 'string' && grounding.allowed.has(answer.sort)) extras.sort = answer.sort;
  if (answer.order === 'asc' || answer.order === 'desc') extras.order = answer.order;
  const url = buildUrl(entity, filters, extras);
  const explanation = typeof answer.explanation === 'string' ? answer.explanation : '';
  const query_id = await record({ question, filters, result_url: url, entity, unknown_terms, asked_by, model: AGENT_MODEL, latency_ms, ...usage });
  return { status: 200, body: { url, entity, filters, explanation, unknown_terms, query_id } };
}

/**
 * POST /api/search/:id/accepted
 *
 * Whether the person actually opened the result is the ONLY honest measure of whether this
 * feature works. Without it the log says what the agent said and never whether it was any use.
 */
export async function accept(id) {
  if (!isUuid(id)) throw new ApiError(400, 'invalid_id', 'Not a valid query id');
  const { error } = await supabaseAdmin().from('agent_queries').update({ accepted: true }).eq('id', id);
  if (error) throw dbError(error);
  return { status: 200, body: { ok: true } };
}

/** GET /api/search/history */
export async function history(query = {}) {
  let q = supabaseAdmin().from('agent_queries').select('*', { count: 'exact' });
  if (query.q) { const term = likeTerm(query.q); if (term) q = q.ilike('question', `*${term}*`); }
  // `refused=1` is the list worth reading: every question the schema could not answer is a
  // candidate field somebody expects to exist.
  if (query.refused === '1' || query.refused === 'true') q = q.not('refusal', 'is', null);
  const { limit, offset } = parsePagination(query);
  const { data, error, count } = await q.order('asked_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}
