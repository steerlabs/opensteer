import { appendFileSync } from "node:fs";
import {
  lockOrderMode,
  lockOrderModeVariable,
  type LockOrderMode,
} from "@opensteer/shared/lockOrderMode";
import { Client, type QueryConfig, type QueryResult, type QueryResultRow } from "pg";
import { advisoryLockResource, databaseLockRank } from "./lock-order.js";

type Token = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly depth: number;
};
const tokenCache = new Map<string, readonly Token[]>();
/** Every statement is lexed several times and the application repeats the same SQL text. */
function tokens(sql: string): readonly Token[] {
  let result = tokenCache.get(sql);
  if (!result) {
    result = lex(sql);
    if (tokenCache.size >= 4_096) tokenCache.clear();
    tokenCache.set(sql, result);
  }
  return result;
}
const dollarQuote = /\$(?:[a-z_][a-z_0-9]*)?\$/iuy;
const identifier = /[a-z_][a-z_0-9$]*/iuy;
/** SQL lexer: comments, escaped quotes and dollar strings cannot create SQL tokens. */
function lex(sql: string): Token[] {
  const result: Token[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const start = i;
    if (/\s/u.test(sql[i]!)) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let nested = 1;
      i += 2;
      while (i < sql.length && nested) {
        if (sql.startsWith("/*", i)) {
          nested++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          nested--;
          i += 2;
        } else i++;
      }
      continue;
    }
    dollarQuote.lastIndex = i;
    const dollar = dollarQuote.exec(sql)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      i = end < 0 ? sql.length : end + dollar.length;
      continue;
    }
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" || (sql[i] === "'" && sql[i + 1] === "'")) i += 2;
        else if (sql[i++] === "'") break;
      }
      continue;
    }
    if (sql[i] === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i++] === '"') break;
      }
      result.push({
        text: sql.slice(start + 1, i - 1).replaceAll('""', '"'),
        start,
        end: i,
        depth,
      });
      continue;
    }
    identifier.lastIndex = i;
    const word = identifier.exec(sql)?.[0];
    if (word) {
      i += word.length;
      result.push({ text: word.toLowerCase(), start, end: i, depth });
      continue;
    }
    if (sql[i] === ")") depth--;
    result.push({ text: sql[i]!, start, end: ++i, depth });
    if (sql[start] === "(") depth++;
  }
  return result;
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Target = { table: string; alias: string };
const reserved = new Set([
  "where",
  "set",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "on",
  "order",
  "group",
  "limit",
  "offset",
  "for",
  "returning",
  "using",
  ")",
  "(",
  ",",
  ";",
  "union",
  "values",
]);
function relation(ts: readonly Token[], start: number): Target | undefined {
  let i = start;
  if (ts[i]?.text === "only") i++;
  let table = ts[i++]?.text;
  if (!table || table === "(" || !/^[a-z_]/iu.test(table)) return;
  if (ts[i]?.text === ".") {
    table = ts[i + 1]?.text;
    i += 2;
  }
  if (!table) return;
  const explicit = ts[i]?.text === "as";
  if (explicit) i++;
  const alias = ts[i]?.text;
  return {
    table: table === "thread_work_inputs" ? "thread_inputs" : table,
    alias: alias && !reserved.has(alias) && /^[a-z_]/iu.test(alias) ? alias : table,
  };
}
const fromClauseEnds = new Set([
  "where",
  "group",
  "having",
  "window",
  "order",
  "limit",
  "offset",
  "fetch",
  "for",
  "union",
  "intersect",
  "except",
  "returning",
]);
/** A LATERAL item or a set-returning function call: neither has rows to lock. */
function fromFunction(ts: readonly Token[], start: number): boolean {
  let i = start;
  if (ts[i]?.text === "lateral") return true;
  if (ts[i]?.text === "only") i++;
  if (ts[i + 1]?.text === ".") i += 2;
  return ts[i + 1]?.text === "(";
}
function topLevelSql(sql: string): string {
  let previous: string;
  let current = sql;
  do {
    previous = current;
    current = current.replace(/\([^()]*\)/gu, " ");
  } while (current !== previous);
  return current;
}
function classify(sql: string): {
  targets: Target[];
  mutation: Target | undefined;
  insert: boolean;
  returning: boolean;
  ts: readonly Token[];
} {
  const ts = tokens(sql);
  const targets: Target[] = [];
  const add = (target: Target | undefined) => {
    if (target && !targets.some((t) => t.table === target.table && t.alias === target.alias))
      targets.push(target);
  };
  const operation = ts[0]?.text;
  const modifies = ts.some(
    (token, index) =>
      ["update", "delete", "insert"].includes(token.text) &&
      !["for", "no", "key"].includes(ts[index - 1]?.text ?? ""),
  );
  // Their row locks would go unseen; refusing them keeps the checker honest.
  if (operation === "merge" || (operation === "with" && modifies))
    throw new Error(`Lock-order checker cannot classify this statement: ${sql.slice(0, 200)}`);
  const mutation =
    operation === "update"
      ? relation(ts, 1)
      : operation === "delete" || operation === "insert"
        ? relation(ts, 2)
        : undefined;
  if (mutation) add(mutation);
  for (let i = 0; i < ts.length; i++) {
    if (ts[i]!.text !== "for" || !["update", "no", "share", "key"].includes(ts[i + 1]?.text ?? ""))
      continue;
    let end = i + 1;
    while (["update", "no", "share", "key"].includes(ts[end]?.text ?? "")) end++;
    const depth = ts[i]!.depth;
    const candidates: Target[] = [];
    const withQueries = new Set(
      ts
        .filter(
          (_, k) =>
            ts[k + 1]?.text === "as" &&
            ["(", "materialized", "not"].includes(ts[k + 2]?.text ?? ""),
        )
        .map((t) => t.text),
    );
    let inFrom = false;
    for (let j = 0; j < i; j++) {
      const token = ts[j]!;
      if (token.depth !== depth) continue;
      if (["from", "join"].includes(token.text)) {
        inFrom = true;
        const target = relation(ts, j + 1);
        if (target) candidates.push(target);
      } else if (fromClauseEnds.has(token.text)) inFrom = false;
      else if (token.text === "," && inFrom && !fromFunction(ts, j + 1)) {
        // A comma-separated FROM item is locked like a joined one.
        const target = relation(ts, j + 1);
        if (target && !withQueries.has(target.table)) candidates.push(target);
      }
    }
    if (ts[end]?.text === "of") {
      for (let j = end + 1; j < ts.length; j += 2) {
        add(candidates.find((t) => t.alias === ts[j]!.text));
        if (ts[j + 1]?.text !== ",") break;
      }
    } else candidates.forEach(add);
  }
  return {
    targets,
    mutation,
    insert: operation === "insert",
    returning: ts.some((t) => t.text === "returning" && t.depth === 0),
    ts,
  };
}

export type RowLockMode = "KEY SHARE" | "SHARE" | "NO KEY UPDATE" | "UPDATE";
const modeStrength: Record<RowLockMode, number> = {
  "KEY SHARE": 0,
  SHARE: 1,
  "NO KEY UPDATE": 2,
  UPDATE: 3,
};
export function rowLockModesConflict(held: RowLockMode, requested: RowLockMode): boolean {
  return (
    held === "UPDATE" ||
    requested === "UPDATE" ||
    (held === "NO KEY UPDATE" && requested !== "KEY SHARE") ||
    (requested === "NO KEY UPDATE" && held !== "KEY SHARE")
  );
}
export function lockOrderRecordOnly(): boolean {
  return lockOrderMode() === "record";
}

/**
 * Runs `observe` under another lock-order mode, then restores the inherited one.
 * A test that asserts on recorded edges opts in with "enforce", so it also runs
 * under a merge gate's `off`. The checker follows a transaction from its BEGIN,
 * so open the scope before the first transaction it should observe.
 */
export async function withLockOrderMode<T>(
  mode: LockOrderMode,
  observe: () => Promise<T>,
): Promise<T> {
  const inherited = process.env[lockOrderModeVariable];
  process.env[lockOrderModeVariable] = mode;
  try {
    return await observe();
  } finally {
    if (inherited === undefined) delete process.env[lockOrderModeVariable];
    else process.env[lockOrderModeVariable] = inherited;
  }
}
function rowMode(value: string): RowLockMode {
  const mode = value.toUpperCase().replace(/^FOR /u, "");
  if (mode === "KEY SHARE" || mode === "SHARE" || mode === "NO KEY UPDATE" || mode === "UPDATE")
    return mode;
  throw new Error(`Unknown PostgreSQL row-lock mode: ${value}`);
}
type Held = {
  resource: string;
  key: string;
  mode: RowLockMode;
  statement: string;
  stack: string;
  statementId?: number;
};
export type LockOrderEdge = {
  database: string;
  type: "edge";
  from: string;
  to: string;
  heldMode: RowLockMode;
  requestedMode: RowLockMode;
  heldKey: string;
  requestedKey: string;
  statement: string;
  previous: string;
  stack: string;
  previousStack: string;
};
export const recordedLockOrderEdges: LockOrderEdge[] = [];
const tracedSignatures = new Set<string>();

/** The checker's own negative cases execute rejected orders on purpose. */
export function isLockOrderFixture(record: unknown): boolean {
  return JSON.stringify(record).includes("/lock-order-checker.integration.test.ts:");
}

/**
 * The suite's cycle check reads one witness per database, resource pair and
 * mode pair. Writing every repetition made a full enforcing run's trace
 * hundreds of megabytes; record mode keeps them all for diagnosis.
 */
function traceEdge(edge: LockOrderEdge): boolean {
  // The suite discards the negative fixture's edges, so they must not stand in
  // for an identical application edge seen later in the same process.
  if (lockOrderRecordOnly() || isLockOrderFixture(edge)) return true;
  const signature = JSON.stringify([
    edge.database,
    edge.from,
    edge.to,
    edge.heldMode,
    edge.requestedMode,
  ]);
  if (tracedSignatures.has(signature)) return false;
  tracedSignatures.add(signature);
  return true;
}
type State = {
  database: string;
  tableNamespace: string;
  statementId: number;
  statementEdges: Set<string>;
  statementViolations: Set<string>;
  held: Map<string, Held>;
  privateRows: Set<string>;
  high?: Held;
  last: Map<string, string>;
  migration: boolean;
  functions: Map<string, readonly string[]>;
  triggers: Map<string, readonly string[]>;
  deferredTables: readonly string[];
  orderedDeferredTables: ReadonlySet<string>;
};
const states = new WeakMap<Client, State>();
const sessionLocks = new WeakMap<Client, Map<string, Held[]>>();
const queues = new WeakMap<Client, Promise<unknown>>();
let statementSequence = 0;
const nativeQueryKey = Symbol.for("opensteer.integration.native-pg-query");
const nativeQuery =
  (Object.getOwnPropertyDescriptor(Client.prototype, nativeQueryKey)?.value as
    typeof Client.prototype.query | undefined) ?? Client.prototype.query;
if (!Object.hasOwn(Client.prototype, nativeQueryKey))
  Object.defineProperty(Client.prototype, nativeQueryKey, { value: nativeQuery });
export const recordedLockOrderViolations: string[] = [];
export const recordedTransactionConflicts: { readonly code: string; readonly statement: string }[] =
  [];

/** For a test that causes conflicts on purpose: claims them so the suite does not fail it. */
export function takeTransactionConflicts(): readonly {
  readonly code: string;
  readonly statement: string;
}[] {
  return recordedTransactionConflicts.splice(0);
}
function raw(client: Client, config: string | QueryConfig): Promise<QueryResult<QueryResultRow>> {
  return Reflect.apply(nativeQuery, client, [config]) as Promise<QueryResult<QueryResultRow>>;
}
function violation(message: string, prior: Held | undefined, current: Held): void {
  recordedLockOrderViolations.push(message);
  const error = new Error(
    `Database lock order: ${message}\nPrevious ${prior?.resource}: ${prior?.statement}\n${prior?.stack}\nNext ${current.resource}: ${current.statement}\n${current.stack}`,
  );
  if (process.env.OPENSTEER_LOCK_ORDER_TRACE) {
    appendFileSync(
      process.env.OPENSTEER_LOCK_ORDER_TRACE,
      JSON.stringify({ type: "violation", message, prior, current }) + "\n",
    );
  }
  if (!lockOrderRecordOnly()) throw error;
}
function acquire(
  state: State,
  resource: string,
  key: string,
  mode: RowLockMode,
  statement: string,
  origin: StatementOrigin,
): void {
  const identity = resource + ":" + key;
  const held = state.held.get(identity);
  if (state.privateRows.has(identity) || (held && modeStrength[held.mode] >= modeStrength[mode]))
    return;
  if (!resource.startsWith("advisory:")) resource = state.tableNamespace + resource;
  const current: Held = {
    resource,
    key,
    mode,
    statement,
    get stack() {
      return origin.stack;
    },
    statementId: state.statementId,
  };
  // Record before enforcing: a rejected edge must remain visible in diagnostics.
  for (const prior of state.held.values()) {
    if (prior.resource === resource) continue;
    // Row IDs remain tracked individually for ordering and upgrades. Graph
    // edges describe statement acquisitions, with representative row keys;
    // repeating the same edge for every pair of rows adds no lock constraint.
    const signature = JSON.stringify([
      prior.statementId,
      prior.resource,
      prior.mode,
      resource,
      mode,
    ]);
    if (state.statementEdges.has(signature)) continue;
    state.statementEdges.add(signature);
    const edge: LockOrderEdge = {
      type: "edge",
      database: state.database,
      from: prior.resource,
      to: resource,
      heldMode: prior.mode,
      requestedMode: mode,
      heldKey: prior.key,
      requestedKey: key,
      statement,
      previous: prior.statement,
      stack: current.stack,
      previousStack: prior.stack,
    };
    recordedLockOrderEdges.push(edge);
    if (process.env.OPENSTEER_LOCK_ORDER_TRACE && traceEdge(edge))
      appendFileSync(process.env.OPENSTEER_LOCK_ORDER_TRACE, JSON.stringify(edge) + "\n");
  }
  const rank = databaseLockRank(resource);
  if (rank < 0) violation(`unranked resource ${resource}`, state.high, current);
  for (const prior of state.held.values())
    if (rank < databaseLockRank(prior.resource) && rowLockModesConflict(prior.mode, mode)) {
      const signature = JSON.stringify([
        prior.statementId,
        prior.resource,
        prior.mode,
        resource,
        mode,
      ]);
      if (!state.statementViolations.has(signature)) {
        state.statementViolations.add(signature);
        violation(`${prior.resource} -> ${resource}`, prior, current);
      }
    }
  const previousKey = state.last.get(resource);
  if (!held && previousKey && key < previousKey)
    for (const prior of state.held.values())
      if (
        prior.resource === resource &&
        prior.key > key &&
        rowLockModesConflict(prior.mode, mode)
      ) {
        const signature = JSON.stringify([
          "descending",
          prior.statementId,
          resource,
          prior.mode,
          mode,
        ]);
        if (!state.statementViolations.has(signature)) {
          state.statementViolations.add(signature);
          violation(`descending ${resource} IDs`, prior, current);
        }
      }
  state.held.set(identity, current);
  if (!state.high || rank > databaseLockRank(state.high.resource)) state.high = current;
  if (!previousKey || key > previousKey) state.last.set(resource, key);
}
/** Whether each name resolves to a relation, and its primary key, in one round trip. */
async function relationCatalog(
  client: Client,
  names: readonly string[],
): Promise<Map<string, { readonly present: boolean; readonly keys: string[] }>> {
  const result = await raw(client, {
    text: `select t.name, to_regclass(t.name) is not null as present,
      array(select a.attname::text from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid=to_regclass(t.name) and i.indisprimary order by array_position(i.indkey,a.attnum)) as keys
      from unnest($1::text[]) as t(name)`,
    values: [names],
  });
  return new Map(
    result.rows.map((row) => [
      String(row.name),
      { present: Boolean(row.present), keys: (row.keys as string[]).map(String) },
    ]),
  );
}
function keyExpression(alias: string, keys: readonly string[]): string {
  return keys.length
    ? `jsonb_build_array(${keys.map((k) => `${quote(alias)}.${quote(k)}`).join(",")})::text`
    : `${quote(alias)}.ctid::text`;
}
/**
 * Installed function bodies (including this session's temporary functions),
 * relations and triggers. Each transaction compares only its digest; the
 * expansion below is recomputed whenever any input changes.
 */
const functionCatalog = `select json_build_array(
  coalesce((select json_agg(json_build_array(p.proname, p.prosrc) order by p.oid) from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where (n.nspname='public' or n.oid=pg_my_temp_schema()) and l.lanname in ('sql','plpgsql')), '[]'),
  coalesce((select json_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname='public' or n.oid=pg_my_temp_schema()) and c.relkind in ('r','p')), '[]'),
  coalesce((select json_agg(json_build_array(c.relname, p.proname, t.tgdeferrable) order by (t.tgtype & 2) desc, t.tgname, c.relname)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid where not t.tgisinternal), '[]')
)::text as catalog`;
type FunctionLocks = Pick<
  State,
  "functions" | "triggers" | "deferredTables" | "orderedDeferredTables"
>;
const functionLockCache = new Map<string, FunctionLocks>();
/** Expand callees before probing their relations, so a trigger wrapper cannot hide its locks.
 * Snapshots below observe only rows this backend actually locked or changed.
 */
async function functionLocks(client: Client, fingerprint: string): Promise<FunctionLocks> {
  const cached = functionLockCache.get(fingerprint);
  if (cached) return cached;
  const row = (
    await raw(client, `select md5(c.catalog) as fingerprint, c.catalog from (${functionCatalog}) c`)
  ).rows[0]!;
  const [procedures, relationNames, triggerRows] = JSON.parse(String(row.catalog)) as [
    [string, string][],
    string[],
    [string, string, boolean][],
  ];
  const relations = new Set(relationNames);
  const byName = new Map(procedures);
  const functions = new Map<string, readonly string[]>();
  const expand = (name: string, visited: Set<string>): string[] => {
    if (visited.has(name)) return [];
    visited.add(name);
    const body = byName.get(name);
    if (!body) return [];
    const ts = lex(body);
    const tables: string[] = [];
    for (let i = 0; i < ts.length; i++) {
      const token = ts[i]!.text;
      if (byName.has(token) && ts[i + 1]?.text === "(") tables.push(...expand(token, visited));
      if (["from", "join", "update", "into"].includes(token)) {
        const target = relation(ts, i + 1);
        if (target && relations.has(target.table)) tables.push(target.table);
      }
    }
    return [...new Set(tables)];
  };
  for (const name of byName.keys()) functions.set(name, expand(name, new Set()));
  const triggers = new Map<string, string[]>();
  const deferredTables = new Set<string>();
  const orderedDeferredTables = new Set<string>();
  for (const [table, procedure, deferrable] of triggerRows) {
    if (deferrable) {
      for (const target of functions.get(procedure) ?? []) deferredTables.add(target);
      // This cursor is the generation-row ordering contract in migration 0078.
      // Check the installed body so a changed implementation cannot retain the ordering claim.
      if (procedure === "opensteer_flush_integration_authority") {
        if (!/order\s+by\s+owner_user_id\s+loop/iu.test(byName.get(procedure) ?? ""))
          throw new Error("Authority generation flush no longer orders owner rows");
        orderedDeferredTables.add("integration_authority_generations");
      }
    }
    triggers.set(table, [
      ...new Set([...(triggers.get(table) ?? []), ...(functions.get(procedure) ?? [])]),
    ]);
  }
  const locks = { functions, triggers, deferredTables: [...deferredTables], orderedDeferredTables };
  if (functionLockCache.size >= 64) functionLockCache.clear();
  functionLockCache.set(String(row.fingerprint), locks);
  return locks;
}
function sessionState(client: Client): State {
  const held = new Map<string, Held>();
  let high: Held | undefined;
  for (const [key, locks] of sessionLocks.get(client) ?? []) {
    const strongest = locks.reduce((left, right) =>
      modeStrength[left.mode] >= modeStrength[right.mode] ? left : right,
    );
    held.set(key, strongest);
    if (!high || databaseLockRank(strongest.resource) > databaseLockRank(high.resource))
      high = strongest;
  }
  return {
    database: JSON.stringify([client.host, client.port, client.database]),
    tableNamespace: "",
    statementId: ++statementSequence,
    statementEdges: new Set(),
    statementViolations: new Set(),
    held,
    privateRows: new Set(),
    last: new Map(),
    migration: false,
    functions: new Map(),
    triggers: new Map(),
    deferredTables: [],
    orderedDeferredTables: new Set(),
    ...(high ? { high } : {}),
  };
}
async function trackAdvisories(
  client: Client,
  config: QueryConfig,
  origin: StatementOrigin,
  state: State,
): Promise<void> {
  const ts = tokens(config.text);
  if (ts.some((token) => token.text === "pg_advisory_unlock_all")) {
    for (const key of sessionLocks.get(client)?.keys() ?? []) state.held.delete(key);
    sessionLocks.delete(client);
    return;
  }
  const expressions: string[] = [];
  const kinds: { mode: RowLockMode; session: boolean; release: boolean }[] = [];
  for (let i = 0; i < ts.length; i++) {
    const name = ts[i]!.text;
    if (
      !/^pg_advisory_(?:xact_)?(?:lock|unlock)(?:_shared)?$/u.test(name) ||
      ts[i + 2]?.text !== "hashtextextended"
    )
      continue;
    const open = ts[i + 3]!;
    const comma = ts
      .slice(i + 4)
      .find((token) => token.text === "," && token.depth === open.depth + 1);
    const close = ts.slice(i + 4).find((token) => token.text === ")" && token.depth === open.depth);
    if (!comma || !close) throw new Error(`Unclassified advisory lock: ${config.text}`);
    expressions.push(
      `jsonb_build_array((${config.text.slice(open.end, comma.start)})::text, (${config.text.slice(comma.end, close.start)})::bigint)`,
    );
    kinds.push({
      mode: name.endsWith("_shared") ? "SHARE" : "UPDATE",
      session: !name.includes("_xact_"),
      release: name.includes("_unlock"),
    });
  }
  if (!expressions.length) return;
  const resolved = await raw(client, {
    text: `select jsonb_build_array(${expressions.join(",")}) as identities`,
    ...(config.values === undefined ? {} : { values: config.values }),
  });
  const identities = resolved.rows[0]!.identities as [string, number][];
  for (const [index, [value, seed]] of identities.entries()) {
    const kind = kinds[index]!;
    const resource = advisoryLockResource(value, seed);
    const identity = resource + ":" + value;
    if (kind.release) {
      const held = sessionLocks.get(client)?.get(identity);
      const index = held?.findIndex((entry) => entry.mode === kind.mode) ?? -1;
      if (held && index >= 0) held.splice(index, 1);
      if (!held?.length) {
        sessionLocks.get(client)?.delete(identity);
        state.held.delete(identity);
      }
      continue;
    }
    acquire(state, resource, value, kind.mode, config.text, origin);
    if (kind.session) {
      let locks = sessionLocks.get(client);
      if (!locks) {
        locks = new Map();
        sessionLocks.set(client, locks);
      }
      locks.set(identity, [
        ...(locks.get(identity) ?? []),
        {
          resource,
          key: value,
          mode: kind.mode,
          statement: config.text,
          get stack() {
            return origin.stack;
          },
          statementId: state.statementId,
        },
      ]);
    }
  }
}
const migrationCaller = /migration\/migrator\.js|packages\/database\/src\/migrations\.ts/u;
/**
 * The code that issued a statement. Formatting a stack maps every frame through
 * the test runner's source maps, so its text is built only for an edge or a
 * violation; the migration exemption reads the frames' files directly.
 */
class StatementOrigin {
  readonly #frames: readonly NodeJS.CallSite[];
  readonly #prepare = Error.prepareStackTrace;
  #stack: string | undefined;
  #fromMigration: boolean | undefined;

  constructor() {
    const limit = Error.stackTraceLimit;
    const holder: { stack?: NodeJS.CallSite[] } = {};
    Error.stackTraceLimit = 40;
    Error.prepareStackTrace = (_error, frames) => frames;
    try {
      // Frames start at the patched query, as they did when it built an Error
      // itself. Reading the stack here, under the override, keeps them unformatted.
      Error.captureStackTrace(holder, StatementOrigin);
      this.#frames = holder.stack ?? [];
    } finally {
      Error.prepareStackTrace = this.#prepare;
      Error.stackTraceLimit = limit;
    }
  }

  get fromMigration(): boolean {
    this.#fromMigration ??= this.#frames.some((frame) =>
      migrationCaller.test(frame.getFileName() || frame.getScriptNameOrSourceURL() || ""),
    );
    return this.#fromMigration;
  }

  get stack(): string {
    if (this.#stack === undefined) {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 0;
      const error = new Error("Lock acquisition");
      Error.stackTraceLimit = limit;
      this.#stack = String(this.#prepare(error, [...this.#frames]));
    }
    return this.#stack;
  }
}
async function checked(
  client: Client,
  config: QueryConfig,
  origin: StatementOrigin,
): Promise<QueryResult<QueryResultRow>> {
  const sql = config.text;
  const statementTokens = tokens(sql);
  const op = statementTokens[0]?.text;
  const open = states.get(client);
  if (open && (open.migration || origin.fromMigration)) {
    // Nothing in a migration transaction is checked, so a batch that neither
    // begins nor ends a transaction runs as sent instead of one statement at a time.
    let starts = true;
    let control = false;
    for (const token of statementTokens) {
      if (starts && ["begin", "start", "commit", "rollback"].includes(token.text)) control = true;
      starts = token.text === ";" && token.depth === 0;
    }
    if (!control) {
      open.migration = true;
      return raw(client, config);
    }
  }
  if (states.has(client) || op === "begin" || op === "start") {
    const parts: string[] = [];
    let start = 0;
    for (const token of statementTokens) {
      if (token.text !== ";" || token.depth !== 0) continue;
      const part = sql.slice(start, token.start);
      if (tokens(part).length) parts.push(part);
      start = token.end;
    }
    if (tokens(sql.slice(start)).length) parts.push(sql.slice(start));
    if (parts.length > 1 && !config.values?.length) {
      const results: QueryResult<QueryResultRow>[] = [];
      for (const part of parts)
        results.push(await checked(client, { ...config, text: part }, origin));
      // pg's simple-query protocol returns one result per statement. This
      // driver-boundary shape is preserved for the adapter's raw SQL batches.
      return results as unknown as QueryResult<QueryResultRow>;
    }
  }
  if (op === "begin" || op === "start") {
    // Migration tests recreate public on a reused client; connection identity
    // does not imply the extension still exists. Check the live catalogue.
    if (
      !(
        await raw(
          client,
          "select to_regprocedure('public.pgrowlocks(text)') is not null as present",
        )
      ).rows[0]!.present
    ) {
      try {
        await raw(client, "create extension if not exists pgrowlocks with schema public");
      } catch (error) {
        // Concurrent first BEGINs can both observe an absent extension. A
        // competing installation is sufficient; never mask any other failure.
        if (
          !(
            await raw(
              client,
              "select to_regprocedure('public.pgrowlocks(text)') is not null as present",
            )
          ).rows[0]!.present
        )
          throw error;
      }
    }
    const result = await raw(client, config);
    // Host and Account service schemas live in separate databases; identically
    // named tables are different resources. Recheck after schema recreation.
    const catalog = (
      await raw(
        client,
        `select to_regclass('public.cloud_deployment_operations') is not null as control_plane, md5(c.catalog) as fingerprint from (${functionCatalog}) c`,
      )
    ).rows[0]!;
    states.set(client, {
      ...sessionState(client),
      tableNamespace: catalog.control_plane ? "control-plane:" : "",
      ...(await functionLocks(client, String(catalog.fingerprint))),
    });
    return result;
  }
  const state = states.get(client);
  if (!state) {
    await trackAdvisories(client, config, origin, sessionState(client));
    return raw(client, config);
  }
  if (op === "commit" || (op === "rollback" && !/rollback\s+to/iu.test(sql))) {
    try {
      if (op === "commit" && !state.migration && state.deferredTables.length)
        await checked(client, { text: "set constraints all immediate" }, origin);
      return await raw(client, config);
    } finally {
      states.delete(client);
    }
  }
  // Kysely's migration transaction uses a database-wide lock and historical DDL.
  // It cannot participate in application row-lock cycles; test/application DML is checked.
  if (/kysely_migration_lock/u.test(sql) || origin.fromMigration) state.migration = true;
  if (state.migration) return raw(client, config);
  state.statementId = ++statementSequence;
  state.statementEdges.clear();
  state.statementViolations.clear();
  await trackAdvisories(client, config, origin, state);
  const classification = classify(sql);
  const flushingDeferred = /^set\s+constraints\s+all\s+immediate\s*;?$/iu.test(sql);
  if (flushingDeferred)
    for (const table of state.deferredTables) classification.targets.push({ table, alias: table });
  for (let i = 0; i < classification.ts.length; i++) {
    const token = classification.ts[i]!;
    if (classification.ts[i + 1]?.text !== "(") continue;
    for (const table of state.functions.get(token.text) ?? []) {
      if (!classification.targets.some((target) => target.table === table))
        classification.targets.push({ table, alias: table });
    }
  }
  if (!classification.targets.length) return raw(client, config);
  const tables = [...new Set(classification.targets.map((t) => t.table))];
  // A mutation's trigger targets join only while they still exist; the first
  // table to name a target places it.
  const triggered: { readonly table: string; readonly target: string }[] = [];
  for (const table of classification.mutation ? tables : [])
    for (const target of state.triggers.get(table) ?? [])
      if (!tables.includes(target) && !triggered.some((entry) => entry.target === target))
        triggered.push({ table, target });
  const catalog = await relationCatalog(client, [
    ...tables,
    ...triggered.map((entry) => entry.target),
  ]);
  for (const { table, target } of triggered)
    if (catalog.get(target)!.present) {
      if (table === "workspace_memberships") tables.unshift(target);
      else tables.push(target);
    }
  const keys = tables.map((table) => catalog.get(table)!.keys);
  // Every table's snapshot and the transaction ID come from one statement, in
  // that order, so the statement below is bracketed by two round trips.
  const snapshots = await raw(
    client,
    tables
      .map(
        (table, index) =>
          `select ${index} as t, ${keyExpression("r", keys[index]!)} as key, r.xmin::text as xmin from ${quote(table)} r union all `,
      )
      .join("") + "select -1, pg_current_xact_id()::text, null",
  );
  // Each table's row keys before the statement, with their xmin.
  const before = tables.map(() => new Map<string, string>());
  let xid = "";
  for (const row of snapshots.rows) {
    if (row.t < 0) xid = String(row.key);
    else before[row.t as number]!.set(String(row.key), String(row.xmin));
  }
  let statement = sql;
  const mutation = classification.mutation;
  if (mutation) {
    const clean = sql.replace(/;\s*$/u, "");
    statement =
      clean +
      (classification.returning ? ", " : " returning ") +
      keyExpression(mutation.alias, keys[tables.indexOf(mutation.table)]!) +
      " as __opensteer_lock_key";
  }
  const result = await raw(client, { ...config, text: statement });
  const observed = await raw(client, {
    text: tables
      .map((table, index) => {
        const key = keyExpression("r", keys[index]!);
        return `select ${index} as t, true as locked, ${key} as key, held.mode as value from public.pgrowlocks($${index + 3}) p join ${quote(table)} r on r.ctid=p.locked_row cross join lateral unnest(p.pids,p.modes) as held(pid,mode) where held.pid=pg_backend_pid() and (held.mode <> 'For Key Share' or $1) union all select ${index}, false, ${key}, r.xmin::text from ${quote(table)} r where r.xmin::text = $2`;
      })
      .join(" union all "),
    values: [
      classification.ts
        .map((token) => token.text)
        .join(" ")
        .includes("for key share"),
      xid,
      ...tables,
    ],
  });
  for (const [index, table] of tables.entries()) {
    const prior = before[index]!;
    const rows = observed.rows.filter((row) => row.t === index);
    const locked = rows.filter((row) => row.locked);
    // Rows this transaction wrote, excluding those it had written before this statement.
    const written = rows
      .filter((row) => !row.locked && prior.get(String(row.key)) !== xid)
      .map((row) => String(row.key));
    const returned =
      mutation?.table === table ? result.rows.map((row) => String(row.__opensteer_lock_key)) : [];
    const acquired = new Map<string, RowLockMode>();
    const note = (key: string, mode: RowLockMode) => {
      const previous = acquired.get(key);
      if (!previous || modeStrength[mode] > modeStrength[previous]) acquired.set(key, mode);
    };
    for (const row of locked) note(String(row.key), rowMode(String(row.value)));
    for (const key of written) note(key, "NO KEY UPDATE");
    for (const key of returned)
      note(key, classification.ts[0]?.text === "delete" ? "UPDATE" : "NO KEY UPDATE");
    for (const key of acquired.keys()) {
      if (!prior.has(key)) state.privateRows.add(table + ":" + key);
    }
    // Multi-row writes need a preceding ordered fence; read-only batches do
    // not conflict with one another. Upgrades remain visible acquisitions.
    // Only a top-level ORDER BY on a locking read orders its row locks: one in
    // a subquery or window does not, and UPDATE or DELETE cannot carry one.
    const statement = topLevelSql(sql);
    const ordered =
      (!/^\s*(?:update|delete|insert)\b/iu.test(statement) && /\border\s+by\b/iu.test(statement)) ||
      (flushingDeferred && state.orderedDeferredTables.has(table));
    const existing = [...acquired].filter(([key, mode]) => {
      const held = state.held.get(table + ":" + key);
      return (
        !state.privateRows.has(table + ":" + key) &&
        (!held || modeStrength[held.mode] < modeStrength[mode])
      );
    });
    if (
      existing.length > 1 &&
      !ordered &&
      existing.some(([, mode]) => rowLockModesConflict(mode, mode))
    )
      violation(`unordered multi-row ${table} acquisition`, state.high, {
        resource: table,
        key: existing.map(([key]) => key).join(","),
        mode: existing[0]![1],
        statement: sql,
        stack: origin.stack,
      });
    for (const [key, mode] of existing.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      acquire(state, table, key, mode, sql, origin);
  }
  if (mutation) {
    for (const row of result.rows) delete row.__opensteer_lock_key;
    result.fields = result.fields.filter((field) => field.name !== "__opensteer_lock_key");
    if (!classification.returning) result.rows = [];
  }
  return result;
}

/** Off: the statement runs as sent, and a transaction observed so far is abandoned. */
function unobserved(client: Client, config: QueryConfig): Promise<QueryResult<QueryResultRow>> {
  states.delete(client);
  return raw(client, config);
}

/** Patch the driver rather than a store factory, covering every pool and direct client. */
export function installLockOrderChecker(): void {
  Client.prototype.query = function (
    this: Client,
    input: string | QueryConfig,
    values?: unknown[] | ((error: Error | null, result?: QueryResult) => void),
    callback?: (error: Error | null, result?: QueryResult) => void,
  ) {
    const config =
      typeof input === "string"
        ? { text: input, ...(Array.isArray(values) ? { values } : {}) }
        : input;
    const cb = typeof values === "function" ? values : callback;
    // Read per statement, so a test can opt in or out for its own scope. Off still
    // queues behind earlier checked statements to keep this client's order.
    const origin = lockOrderMode() === "off" ? undefined : new StatementOrigin();
    const previous = queues.get(this) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => (origin ? checked(this, config, origin) : unobserved(this, config)))
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "40P01" || error.code === "40001")
        ) {
          recordedTransactionConflicts.push({ code: error.code, statement: config.text });
        }
        throw error;
      });
    queues.set(this, pending);
    if (cb) {
      void pending.then(
        (result) => cb(null, result),
        (error) => cb(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    return pending;
  } as typeof Client.prototype.query;
}

/**
 * A vertex is an acquisition edge, including both modes. Edges can wait on
 * each other only when the requested mode conflicts with the next holder at
 * their shared resource. SCCs therefore include cycles of every length, even
 * a reader/reader path opposed by a writer/writer path.
 * Return a witness through every cyclic acquisition signature; no length cap.
 */
export function findConflictingLockCycles(
  edges: readonly LockOrderEdge[],
): readonly (readonly LockOrderEdge[])[] {
  const unique = new Map<string, LockOrderEdge>();
  for (const edge of edges) {
    const key = JSON.stringify([
      edge.database,
      edge.from,
      edge.to,
      edge.heldMode,
      edge.requestedMode,
    ]);
    if (edge.from !== edge.to && !unique.has(key)) unique.set(key, edge);
  }
  const vertices = [...unique.values()];
  const outgoing = new Map<string, number[]>();
  for (const [index, edge] of vertices.entries())
    outgoing.set(JSON.stringify([edge.database, edge.from]), [
      ...(outgoing.get(JSON.stringify([edge.database, edge.from])) ?? []),
      index,
    ]);
  const graph = vertices.map((edge) =>
    (outgoing.get(JSON.stringify([edge.database, edge.to])) ?? []).filter((next) =>
      rowLockModesConflict(edge.requestedMode, vertices[next]!.heldMode),
    ),
  );
  const indices = new Map<number, number>();
  const low = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const components: number[][] = [];
  const visit = (vertex: number): void => {
    indices.set(vertex, indices.size);
    low.set(vertex, indices.get(vertex)!);
    stack.push(vertex);
    onStack.add(vertex);
    for (const next of graph[vertex]!) {
      if (!indices.has(next)) {
        visit(next);
        low.set(vertex, Math.min(low.get(vertex)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(vertex, Math.min(low.get(vertex)!, indices.get(next)!));
    }
    if (low.get(vertex) !== indices.get(vertex)) return;
    const component: number[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === vertex) break;
    }
    if (component.length > 1 || graph[vertex]!.includes(vertex)) components.push(component);
  };
  for (const index of vertices.keys()) if (!indices.has(index)) visit(index);
  const witnesses = new Map<string, readonly LockOrderEdge[]>();
  for (const component of components) {
    const members = new Set(component);
    for (const start of component) {
      const queue = [[start]];
      const seen = new Set([start]);
      let witness: number[] | undefined;
      for (let index = 0; index < queue.length && !witness; index++) {
        const route = queue[index]!;
        for (const next of graph[route.at(-1)!]!) {
          if (!members.has(next)) continue;
          if (next === start) {
            witness = route;
            break;
          }
          if (!seen.has(next)) {
            seen.add(next);
            queue.push([...route, next]);
          }
        }
      }
      if (!witness) throw new Error("Cyclic component has no return path");
      const first = witness.indexOf(Math.min(...witness));
      const canonical = [...witness.slice(first), ...witness.slice(0, first)];
      witnesses.set(
        canonical.join(","),
        canonical.map((index) => vertices[index]!),
      );
    }
  }
  return [...witnesses.values()];
}

/** Test database isolation must not hide paths that can meet in one deployed Host. */
export function findConflictingApplicationLockCycles(edges: readonly LockOrderEdge[]) {
  const accountDatabases = new Set(
    edges
      .filter(
        (edge) => edge.from.startsWith("control-plane:") || edge.to.startsWith("control-plane:"),
      )
      .map((edge) => edge.database),
  );
  return findConflictingLockCycles(
    edges.map((edge) => ({
      ...edge,
      database: accountDatabases.has(edge.database) ? "control-plane-schema" : "host-schema",
    })),
  );
}
