/**
 * Argument grammar of the time series commands. Each DTO parses the arguments after the command name (`args`); options
 * are read left to right and the first problem is the error reported. Checks that need the keyspace or the config
 * (the key exists, its type, defaults) stay in the services.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { toFloat } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import { KeySchema, reject } from '@/libs/schemas';
import type { Parsed } from '@/libs/schemas';

import { AggregatorEnum, ChunkEncodingEnum, DuplicatePolicyEnum, ReducerEnum } from './timeseries.enums';
import type { Aggregator, BucketTimestamp, DuplicatePolicy } from './timeseries.enums';
import TimeseriesMessages from './timeseries.messages';
import type { AggregationSpec, Align, GroupBy, LabelMatcher, LabelSelection, PolicyRule, RangeQuery, SeriesOptions } from './timeseries.types';

// ============================================================================
// Primitives
// ============================================================================

const NONNEG_INT_RE = /^(0|[1-9]\d*)$/;
const INT_RE = /^-?(0|[1-9]\d*)$/;

/** The largest timestamp redis-lite represents exactly (`+` in a range). */
export const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

/** A non-negative integer within the JS safe range, or null. */
function nonNegInt(raw: string | undefined): number | null {
  if (raw === undefined || !NONNEG_INT_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** A signed integer within the JS safe range, or null. */
function signedInt(raw: string | undefined): number | null {
  if (raw === undefined || !INT_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** A sample value: any double, `inf` / `-inf` and `nan` included. */
function sampleValue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (raw.toLowerCase() === 'nan') return NaN;
  return toFloat(raw);
}

/** `*` (the server time, resolved by the service) or a non-negative timestamp. */
function sampleTimestamp(raw: string): number | '*' | null {
  return raw === '*' ? '*' : nonNegInt(raw);
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// ============================================================================
// Series options: TS.CREATE, TS.ALTER, TS.ADD, TS.INCRBY / TS.DECRBY
// ============================================================================

type OptionsParse = { options: SeriesOptions; onDuplicate?: DuplicatePolicy; timestamp?: number | '*' };

const CREATE_KEYWORDS = new Set(['RETENTION', 'ENCODING', 'CHUNK_SIZE', 'DUPLICATE_POLICY', 'IGNORE', 'LABELS']);
const ALTER_KEYWORDS = new Set(['RETENTION', 'CHUNK_SIZE', 'DUPLICATE_POLICY', 'IGNORE', 'LABELS']);
const ADD_KEYWORDS = new Set([...CREATE_KEYWORDS, 'ON_DUPLICATE']);
const INCRBY_KEYWORDS = new Set([...CREATE_KEYWORDS, 'TIMESTAMP']);

/** One option with its arguments at tokens[i]; returns how many tokens it used. */
function parseOption(tokens: string[], i: number, out: OptionsParse): Parsed<number> {
  const M = TimeseriesMessages;
  const arg = tokens[i + 1];
  switch (tokens[i].toUpperCase()) {
    case 'RETENTION': {
      const n = nonNegInt(arg);
      if (n === null) return fail(M.BAD_RETENTION);
      out.options.retention = n;
      return { ok: true, value: 2 };
    }
    case 'ENCODING': {
      const enc = ChunkEncodingEnum.safeParse(arg?.toLowerCase());
      if (!enc.success) return fail(M.BAD_ENCODING);
      out.options.encoding = enc.data;
      return { ok: true, value: 2 };
    }
    case 'CHUNK_SIZE': {
      const n = signedInt(arg);
      if (n === null) return fail(M.BAD_CHUNK_SIZE);
      if (n < 48 || n > 1048576 || n % 8) return fail(M.CHUNK_SIZE_RANGE);
      out.options.chunkSize = n;
      return { ok: true, value: 2 };
    }
    case 'DUPLICATE_POLICY':
    case 'ON_DUPLICATE': {
      const policy = DuplicatePolicyEnum.safeParse(arg?.toLowerCase());
      const onDuplicate = tokens[i].toUpperCase() === 'ON_DUPLICATE';
      if (!policy.success) return fail(onDuplicate ? M.BAD_ON_DUPLICATE : M.BAD_DUPLICATE_POLICY);
      if (onDuplicate) out.onDuplicate = policy.data;
      else out.options.duplicatePolicy = policy.data;
      return { ok: true, value: 2 };
    }
    case 'IGNORE': {
      const maxTimeDiff = nonNegInt(arg);
      const maxValDiff = toFloat(tokens[i + 2] ?? '');
      if (maxTimeDiff === null || maxValDiff === null || maxValDiff < 0) return fail(M.BAD_IGNORE);
      out.options.ignore = { maxTimeDiff, maxValDiff };
      return { ok: true, value: 3 };
    }
    case 'TIMESTAMP': {
      const ts = arg === undefined ? null : sampleTimestamp(arg);
      if (ts === null) return fail(M.INVALID_TIMESTAMP);
      out.timestamp = ts;
      return { ok: true, value: 2 };
    }
    default: {
      // LABELS label value [label value …]: the rest of the arguments
      const rest = tokens.slice(i + 1);
      if (rest.length % 2) return fail(M.BAD_LABELS);
      const labels: Array<[string, string]> = [];
      for (let j = 0; j < rest.length; j += 2) labels.push([rest[j], rest[j + 1]]);
      out.options.labels = labels;
      return { ok: true, value: tokens.length - i };
    }
  }
}

/** The option list of a create-like command; anything not in `allowed` is a syntax error. */
function parseOptions(tokens: string[], allowed: ReadonlySet<string>): Parsed<OptionsParse> {
  const out: OptionsParse = { options: { labels: null } };
  for (let i = 0; i < tokens.length; ) {
    if (!allowed.has(tokens[i].toUpperCase())) return fail(RespMessages.SYNTAX);
    const used = parseOption(tokens, i, out);
    if (!used.ok) return used;
    i += used.value;
  }
  return { ok: true, value: out };
}

// ============================================================================
// Range options: TS.RANGE family, TS.MGET
// ============================================================================

const RANGE_KEYWORDS = new Set(['LATEST', 'FILTER_BY_TS', 'FILTER_BY_VALUE', 'COUNT', 'ALIGN', 'AGGREGATION', 'BUCKETTIMESTAMP', 'EMPTY']);
const MULTI_KEYWORDS = new Set([...RANGE_KEYWORDS, 'WITHLABELS', 'SELECTED_LABELS', 'FILTER']);

type RangeParse = {
  query: RangeQuery;
  labels: LabelSelection;
  filters: LabelMatcher[] | null;
  groupBy: GroupBy | null;
};

/** `label=value`, `label!=value`, `label=`, `label!=`, `label=(a,b,…)`, `label!=(a,b,…)`. */
function parseMatcher(expr: string): LabelMatcher | null {
  const eq = expr.indexOf('=');
  if (eq <= 0) return null;
  const negate = expr[eq - 1] === '!';
  const label = expr.slice(0, negate ? eq - 1 : eq);
  if (!label) return null;
  const rest = expr.slice(eq + 1);
  if (rest.startsWith('(') && rest.endsWith(')')) {
    return { label, negate, values: rest.slice(1, -1).split(',').filter((v) => v !== '') };
  }
  return { label, negate, values: rest === '' ? [] : [rest] };
}

/** The FILTER expressions; at least one must select by value (`label=value` / `label=(…)`). */
function parseFilters(exprs: string[]): Parsed<LabelMatcher[]> {
  if (!exprs.length) return fail(TimeseriesMessages.MISSING_FILTER);
  const matchers: LabelMatcher[] = [];
  for (const expr of exprs) {
    const m = parseMatcher(expr);
    if (!m) return fail(TimeseriesMessages.BAD_FILTER);
    matchers.push(m);
  }
  if (!matchers.some((m) => !m.negate && m.values.length)) return fail(TimeseriesMessages.NO_MATCHER);
  return { ok: true, value: matchers };
}

function parseAlign(raw: string | undefined): Align | null {
  if (raw === '-' || raw?.toLowerCase() === 'start') return { kind: 'start' };
  if (raw === '+' || raw?.toLowerCase() === 'end') return { kind: 'end' };
  const n = signedInt(raw);
  return n === null ? null : { kind: 'timestamp', value: n };
}

function parseBucketTimestamp(raw: string | undefined): BucketTimestamp | null {
  const lower = raw?.toLowerCase();
  if (lower === '-' || lower === 'start') return 'start';
  if (lower === '+' || lower === 'end') return 'end';
  if (lower === '~' || lower === 'mid') return 'mid';
  return null;
}

/** `aggregator bucketDuration` after AGGREGATION (also TS.CREATERULE). */
function parseAggregation(name: string | undefined, duration: string | undefined): Parsed<{ aggregator: Aggregator; bucketDuration: number }> {
  if (name === undefined || duration === undefined) return fail(TimeseriesMessages.BAD_AGGREGATION);
  const aggregator = AggregatorEnum.safeParse(name.toLowerCase());
  if (!aggregator.success) return fail(TimeseriesMessages.UNKNOWN_AGGREGATION);
  const n = signedInt(duration);
  if (n === null) return fail(TimeseriesMessages.BAD_AGGREGATION);
  if (n <= 0) return fail(TimeseriesMessages.BAD_BUCKET_DURATION);
  return { ok: true, value: { aggregator: aggregator.data, bucketDuration: n } };
}

/** `-` / `+` or a non-negative timestamp. */
function rangeBound(raw: string, which: 'from' | 'to'): Parsed<number> {
  if (raw === '-') return { ok: true, value: 0 };
  if (raw === '+') return { ok: true, value: MAX_TIMESTAMP };
  const n = nonNegInt(raw);
  return n === null ? fail(which === 'from' ? TimeseriesMessages.BAD_FROM : TimeseriesMessages.BAD_TO) : { ok: true, value: n };
}

/** The options of a range query (and, for `multi`, the label selection, FILTER and GROUPBY of TS.MRANGE / TS.MGET). */
function parseRange(from: number, to: number, tokens: string[], multi: boolean): Parsed<RangeParse> {
  const M = TimeseriesMessages;
  const query: RangeQuery = { from, to, latest: false, filterByTs: null, filterByValue: null, count: null, aggregation: null };
  const out: RangeParse = { query, labels: { kind: 'none' }, filters: null, groupBy: null };
  const keywords = multi ? MULTI_KEYWORDS : RANGE_KEYWORDS;
  let align: Align | null = null;
  let bucketTimestamp: BucketTimestamp | null = null;
  let empty = false;
  let agg: { aggregator: Aggregator; bucketDuration: number } | null = null;
  let withLabels = false;
  let selected: string[] | null = null;
  let i = 0;
  while (i < tokens.length) {
    const kw = tokens[i].toUpperCase();
    if (!keywords.has(kw)) return fail(RespMessages.SYNTAX);
    if (kw === 'FILTER') break;
    i++;
    if (kw === 'LATEST') query.latest = true;
    else if (kw === 'EMPTY') empty = true;
    else if (kw === 'WITHLABELS') withLabels = true;
    else if (kw === 'SELECTED_LABELS') {
      selected = [];
      while (i < tokens.length && !keywords.has(tokens[i].toUpperCase())) selected.push(tokens[i++]);
    } else if (kw === 'FILTER_BY_TS') {
      const list: number[] = [];
      for (let ts = nonNegInt(tokens[i]); ts !== null; ts = nonNegInt(tokens[i])) {
        list.push(ts);
        i++;
      }
      if (!list.length) return fail(M.BAD_FILTER_BY_TS);
      query.filterByTs = list;
    } else if (kw === 'FILTER_BY_VALUE') {
      const min = sampleValue(tokens[i]);
      const max = sampleValue(tokens[i + 1]);
      if (min === null || max === null || Number.isNaN(min) || Number.isNaN(max)) return fail(M.BAD_FILTER_BY_VALUE);
      query.filterByValue = [min, max];
      i += 2;
    } else if (kw === 'COUNT') {
      const n = nonNegInt(tokens[i++]);
      if (n === null || n === 0) return fail(M.BAD_COUNT);
      query.count = n;
    } else if (kw === 'ALIGN') {
      align = parseAlign(tokens[i++]);
      if (!align) return fail(M.BAD_ALIGN);
    } else if (kw === 'AGGREGATION') {
      const parsed = parseAggregation(tokens[i], tokens[i + 1]);
      if (!parsed.ok) return parsed;
      agg = parsed.value;
      i += 2;
    } else {
      bucketTimestamp = parseBucketTimestamp(tokens[i++]);
      if (!bucketTimestamp) return fail(M.BAD_BUCKET_TIMESTAMP);
    }
  }
  if (withLabels && selected) return fail(M.LABELS_CONFLICT);
  if (!agg && align) return fail(M.ALIGN_WITHOUT_AGGREGATION);
  if (!agg && bucketTimestamp) return fail(M.BUCKET_TIMESTAMP_WITHOUT_AGGREGATION);
  if (!agg && empty) return fail(M.EMPTY_WITHOUT_AGGREGATION);
  if (agg) {
    const spec: AggregationSpec = { ...agg, align: align ?? { kind: 'timestamp', value: 0 }, bucketTimestamp: bucketTimestamp ?? 'start', empty };
    query.aggregation = spec;
  }
  out.labels = withLabels ? { kind: 'all' } : selected ? { kind: 'selected', labels: selected } : { kind: 'none' };
  if (!multi) return { ok: true, value: out };
  // FILTER expr… [GROUPBY label REDUCE reducer]
  if (i >= tokens.length) return fail(M.MISSING_FILTER);
  const rest = tokens.slice(i + 1);
  const at = rest.findIndex((t) => t.toUpperCase() === 'GROUPBY');
  const filters = parseFilters(at < 0 ? rest : rest.slice(0, at));
  if (!filters.ok) return filters;
  out.filters = filters.value;
  if (at >= 0) {
    const g = rest.slice(at + 1);
    if (g.length !== 3 || g[1].toUpperCase() !== 'REDUCE') return fail(M.BAD_GROUPBY);
    const reducer = ReducerEnum.safeParse(g[2].toLowerCase());
    if (!reducer.success) return fail(M.UNKNOWN_REDUCER);
    out.groupBy = { label: g[0], reducer: reducer.data };
  }
  return { ok: true, value: out };
}

// ============================================================================
// Create / ingest DTOs: TS.CREATE, TS.ALTER, TS.ADD, TS.MADD, TS.INCRBY, TS.DECRBY, TS.DEL
// ============================================================================

export const CreateDTO = z.tuple([KeySchema], z.string()).transform(([key, ...tokens], ctx) => {
  const parsed = parseOptions(tokens, CREATE_KEYWORDS);
  return parsed.ok ? { key, options: parsed.value.options } : reject(ctx, parsed.error);
});

export const AlterDTO = z.tuple([KeySchema], z.string()).transform(([key, ...tokens], ctx) => {
  const parsed = parseOptions(tokens, ALTER_KEYWORDS);
  return parsed.ok ? { key, options: parsed.value.options } : reject(ctx, parsed.error);
});

/** TS.ADD key timestamp value [options]: the timestamp, then the value, then the options. */
export const AddDTO = z.tuple([KeySchema, z.string(), z.string()], z.string()).transform(([key, rawTs, rawValue, ...tokens], ctx) => {
  const timestamp = sampleTimestamp(rawTs);
  if (timestamp === null) return reject(ctx, TimeseriesMessages.INVALID_TIMESTAMP);
  const value = sampleValue(rawValue);
  if (value === null) return reject(ctx, TimeseriesMessages.INVALID_VALUE);
  const parsed = parseOptions(tokens, ADD_KEYWORDS);
  if (!parsed.ok) return reject(ctx, parsed.error);
  return { key, timestamp, value, options: parsed.value.options, onDuplicate: parsed.value.onDuplicate ?? null };
});

/** TS.MADD key timestamp value [key timestamp value …]: a count that is not a multiple of 3 is an arity error. */
export const MAddDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length % 3) return reject(ctx, formatMessage(RespMessages.WRONG_ARITY, { command: 'ts.madd' }));
  const samples: Array<{ key: string; timestamp: number | '*'; value: number }> = [];
  for (let i = 0; i < args.length; i += 3) {
    const timestamp = sampleTimestamp(args[i + 1]);
    if (timestamp === null) return reject(ctx, TimeseriesMessages.INVALID_TIMESTAMP);
    const value = sampleValue(args[i + 2]);
    if (value === null) return reject(ctx, TimeseriesMessages.INVALID_VALUE);
    samples.push({ key: args[i], timestamp, value });
  }
  return { samples };
});

function IncrByDTOFor(sign: 1 | -1) {
  return z.tuple([KeySchema, z.string()], z.string()).transform(([key, raw, ...tokens], ctx) => {
    const delta = toFloat(raw);
    if (delta === null) return reject(ctx, TimeseriesMessages.INVALID_VALUE);
    const parsed = parseOptions(tokens, INCRBY_KEYWORDS);
    if (!parsed.ok) return reject(ctx, parsed.error);
    return { key, delta: sign * delta, timestamp: parsed.value.timestamp ?? ('*' as const), options: parsed.value.options };
  });
}

export const IncrByDTO = IncrByDTOFor(1);
export const DecrByDTO = IncrByDTOFor(-1);

export const DelDTO = z.tuple([KeySchema, z.string(), z.string()]).transform(([key, rawFrom, rawTo], ctx) => {
  const from = rangeBound(rawFrom, 'from');
  if (!from.ok) return reject(ctx, from.error);
  const to = rangeBound(rawTo, 'to');
  if (!to.ok) return reject(ctx, to.error);
  return { key, from: from.value, to: to.value };
});

// ============================================================================
// Read DTOs: TS.GET, TS.RANGE / TS.REVRANGE, TS.MGET, TS.MRANGE / TS.MREVRANGE, TS.QUERYINDEX, TS.INFO
// ============================================================================

/** `key [FLAG]` where FLAG is the only option (TS.GET LATEST, TS.INFO DEBUG). */
function KeyFlagDTO(flag: string) {
  return z.tuple([KeySchema], z.string()).transform(([key, ...tokens], ctx) => {
    if (tokens.length > 1 || (tokens.length === 1 && tokens[0].toUpperCase() !== flag)) return reject(ctx, RespMessages.SYNTAX);
    return { key, flag: tokens.length === 1 };
  });
}

export const GetDTO = KeyFlagDTO('LATEST');
export const InfoDTO = KeyFlagDTO('DEBUG');

export const RangeDTO = z.tuple([KeySchema, z.string(), z.string()], z.string()).transform(([key, rawFrom, rawTo, ...tokens], ctx) => {
  const from = rangeBound(rawFrom, 'from');
  if (!from.ok) return reject(ctx, from.error);
  const to = rangeBound(rawTo, 'to');
  if (!to.ok) return reject(ctx, to.error);
  const parsed = parseRange(from.value, to.value, tokens, false);
  return parsed.ok ? { key, query: parsed.value.query } : reject(ctx, parsed.error);
});

export const MRangeDTO = z.tuple([z.string(), z.string()], z.string()).transform(([rawFrom, rawTo, ...tokens], ctx) => {
  const from = rangeBound(rawFrom, 'from');
  if (!from.ok) return reject(ctx, from.error);
  const to = rangeBound(rawTo, 'to');
  if (!to.ok) return reject(ctx, to.error);
  const parsed = parseRange(from.value, to.value, tokens, true);
  if (!parsed.ok) return reject(ctx, parsed.error);
  const { query, labels, filters, groupBy } = parsed.value;
  return { query, labels, filters: filters ?? [], groupBy };
});

/** TS.MGET [LATEST] [WITHLABELS | SELECTED_LABELS label…] FILTER expr… */
export const MGetDTO = z.array(z.string()).transform((tokens, ctx) => {
  const at = tokens.findIndex((t) => t.toUpperCase() === 'FILTER');
  if (at < 0) return reject(ctx, TimeseriesMessages.MISSING_FILTER);
  let latest = false;
  let withLabels = false;
  let selected: string[] | null = null;
  for (let i = 0; i < at; i++) {
    const kw = tokens[i].toUpperCase();
    if (kw === 'LATEST') latest = true;
    else if (kw === 'WITHLABELS') withLabels = true;
    else if (kw === 'SELECTED_LABELS') {
      selected = tokens.slice(i + 1, at);
      i = at;
    } else return reject(ctx, RespMessages.SYNTAX);
  }
  if (withLabels && selected) return reject(ctx, TimeseriesMessages.LABELS_CONFLICT);
  const filters = parseFilters(tokens.slice(at + 1));
  if (!filters.ok) return reject(ctx, filters.error);
  const labels: LabelSelection = withLabels ? { kind: 'all' } : selected ? { kind: 'selected', labels: selected } : { kind: 'none' };
  return { latest, labels, filters: filters.value };
});

export const QueryIndexDTO = z.array(z.string()).transform((tokens, ctx) => {
  const filters = parseFilters(tokens);
  return filters.ok ? { filters: filters.value } : reject(ctx, filters.error);
});

// ============================================================================
// Rule DTOs: TS.CREATERULE, TS.DELETERULE
// ============================================================================

/** TS.CREATERULE sourceKey destKey AGGREGATION aggregator bucketDuration [alignTimestamp] */
export const CreateRuleDTO = z.tuple([KeySchema, KeySchema], z.string()).transform(([sourceKey, destKey, ...tokens], ctx) => {
  if (tokens[0]?.toUpperCase() !== 'AGGREGATION' || tokens.length < 3) return reject(ctx, TimeseriesMessages.BAD_AGGREGATION);
  if (tokens.length > 4) return reject(ctx, RespMessages.SYNTAX);
  const agg = parseAggregation(tokens[1], tokens[2]);
  if (!agg.ok) return reject(ctx, agg.error);
  const alignTimestamp = tokens.length === 4 ? signedInt(tokens[3]) : 0;
  if (alignTimestamp === null) return reject(ctx, TimeseriesMessages.BAD_ALIGN);
  return { sourceKey, destKey, ...agg.value, alignTimestamp };
});

export const DeleteRuleDTO = z.tuple([KeySchema, KeySchema]).transform(([sourceKey, destKey]) => ({ sourceKey, destKey }));

// ============================================================================
// Config grammar: ts-compaction-policy
// ============================================================================

const DURATION_RE = /^(\d+)(ms|s|m|h|d)?$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

function duration(raw: string): number | null {
  const m = DURATION_RE.exec(raw);
  if (!m) return null;
  const n = Number(m[1]) * UNIT_MS[m[2] ?? 'ms'];
  return Number.isSafeInteger(n) ? n : null;
}

/** `aggregator:bucket:retention[:align]` rules separated by `;` (durations with an ms / s / m / h / d unit); "" = none. */
export const CompactionPolicySchema = z.string().transform((raw, ctx) => {
  const rules: PolicyRule[] = [];
  for (const part of raw.split(';').filter((p) => p.trim() !== '')) {
    const [name, bucket, retention, align, ...extra] = part.trim().split(':');
    const aggregator = AggregatorEnum.safeParse((name ?? '').toLowerCase());
    const bucketDuration = duration(bucket ?? '');
    const keep = duration(retention ?? '');
    const alignTimestamp = align === undefined ? 0 : duration(align);
    if (!aggregator.success || !bucketDuration || keep === null || alignTimestamp === null || extra.length) {
      return reject(ctx, TimeseriesMessages.BAD_COMPACTION_POLICY);
    }
    rules.push({ aggregator: aggregator.data, bucketDuration, retention: keep, alignTimestamp });
  }
  return rules;
});

// ============================================================================
// Type Exports
// ============================================================================

export type CreateInput = z.infer<typeof CreateDTO>;
export type AlterInput = z.infer<typeof AlterDTO>;
export type AddInput = z.infer<typeof AddDTO>;
export type MAddInput = z.infer<typeof MAddDTO>;
export type IncrByInput = z.infer<typeof IncrByDTO>;
export type DelInput = z.infer<typeof DelDTO>;
export type KeyFlagInput = z.infer<typeof GetDTO>;
export type RangeInput = z.infer<typeof RangeDTO>;
export type MRangeInput = z.infer<typeof MRangeDTO>;
export type MGetInput = z.infer<typeof MGetDTO>;
export type QueryIndexInput = z.infer<typeof QueryIndexDTO>;
export type CreateRuleInput = z.infer<typeof CreateRuleDTO>;
export type DeleteRuleInput = z.infer<typeof DeleteRuleDTO>;
