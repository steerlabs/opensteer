import { OpensteerError, type OpensteerErrorCode } from "@opensteer/core";
import type {
  A_ArrayExpr,
  A_Const,
  A_Expr,
  A_Indices,
  A_Indirection,
  Alias,
  BooleanTest,
  BoolExpr,
  CaseExpr,
  CaseWhen,
  CoalesceExpr,
  CollateClause,
  ColumnRef,
  CommonTableExpr,
  FuncCall,
  GroupingFunc,
  GroupingSet,
  InsertStmt,
  JoinExpr,
  JsonAggConstructor,
  JsonArgument,
  JsonArrayAgg,
  JsonArrayConstructor,
  JsonArrayQueryConstructor,
  JsonBehavior,
  JsonFormat,
  JsonFuncExpr,
  JsonIsPredicate,
  JsonKeyValue,
  JsonObjectAgg,
  JsonObjectConstructor,
  JsonOutput,
  JsonParseExpr,
  JsonReturning,
  JsonScalarExpr,
  JsonSerializeExpr,
  JsonTable,
  JsonTableColumn,
  JsonTablePathSpec,
  JsonValueExpr,
  MinMaxExpr,
  NullTest,
  ParamRef,
  RangeFunction,
  RangeSubselect,
  RangeVar,
  RawStmt,
  ResTarget,
  RowExpr,
  SelectStmt,
  SortBy,
  SQLValueFunction,
  SubLink,
  TypeCast,
  TypeName,
  WindowDef,
  WithClause,
} from "@pgsql/types";

// Imported on first use so a Host with the trial off never resolves the parser package.
let parserModule: Promise<typeof import("libpg-query")> | undefined;
async function loadParser(): Promise<typeof import("libpg-query")> {
  parserModule ??= import("libpg-query");
  const parser = await parserModule;
  await parser.loadModule();
  return parser;
}

export const knowledgeSqlLimits = {
  textBytes: 16_384,
  parameters: 64,
  insertRows: 25,
  nesting: 128,
} as const;

export type KnowledgeSqlRefusalReason =
  | "too-large"
  | "syntax"
  | "statement"
  | "relation"
  | "function"
  | "operator"
  | "type"
  | "form"
  | "insert"
  | "parameter";

export interface KnowledgeSqlInput {
  readonly text: string;
  readonly parameters: readonly unknown[];
}

export interface KnowledgeFactKey {
  readonly topic: string;
  readonly thing: string;
  readonly property: string;
}

export type KnowledgeSqlAdmission =
  | {
      readonly kind: "select";
      /** Ends in a newline so a trailing line comment cannot swallow text the manager wraps around it. */
      readonly text: string;
    }
  | {
      readonly kind: "insert";
      readonly text: string;
      readonly rowCount: number;
      readonly topicIds: readonly string[];
      readonly keys: readonly KnowledgeFactKey[];
      readonly suppliesBaseline: boolean;
    };

/** Admits one root SELECT or one INSERT ... VALUES into facts; throws an `OpensteerError` whose `reason` is a `KnowledgeSqlRefusalReason`. */
export async function admitKnowledgeSql(input: KnowledgeSqlInput): Promise<KnowledgeSqlAdmission> {
  if (Buffer.byteLength(input.text, "utf8") > knowledgeSqlLimits.textBytes) {
    refuse(
      "too-large",
      "That statement is too long. Send at most 16 KiB of SQL.",
      "resource_exhausted",
    );
  }
  if (input.parameters.length > knowledgeSqlLimits.parameters) {
    refuse("too-large", "Send at most 64 parameters.", "resource_exhausted");
  }
  if (input.text.trim() === "") refuse("statement", statementMessage);
  if (input.text.includes("\0")) refuse("syntax", "The statement contains a NUL character.");
  const parser = await loadParser();
  let tree: unknown;
  try {
    tree = parser.parseSync(input.text);
  } catch (error) {
    refuse(...parseFailure(error, input.text));
  }
  return admitTree(tree, input);
}

const scopeHint = "You can query facts and fact_history.";
const statementMessage = "Send one SELECT, or one INSERT INTO facts ... VALUES.";
const formMessage = `That SQL form isn't allowed. ${scopeHint}`;

function refuse(
  reason: KnowledgeSqlRefusalReason,
  message: string,
  code: OpensteerErrorCode = "bad_request",
): never {
  throw new OpensteerError({ code, reason, message });
}

function parseFailure(
  error: unknown,
  text: string,
): [KnowledgeSqlRefusalReason, string, OpensteerErrorCode?] {
  const details =
    error instanceof Error && "sqlDetails" in error ? (error.sqlDetails as unknown) : undefined;
  if (
    typeof details === "object" &&
    details !== null &&
    "cursorPosition" in details &&
    typeof details.cursorPosition === "number"
  ) {
    const character =
      Buffer.from(text, "utf8").subarray(0, details.cursorPosition).toString("utf8").length + 1;
    return ["syntax", `PostgreSQL can't parse this statement near character ${character}.`];
  }
  return [
    "too-large",
    "That statement is too complex to check. Simplify it.",
    "resource_exhausted",
  ];
}

type Body = Readonly<Record<string, unknown>>;

interface Scope {
  readonly ctes: ReadonlySet<string>;
  readonly depth: number;
  readonly parameters: readonly unknown[];
}

type Rule =
  | "location"
  | "bool"
  | "int"
  | "name"
  | "expr"
  | "exprs"
  | readonly string[]
  | ((value: unknown, scope: Scope) => void);

type Rules<T> = { readonly [K in keyof T]?: Rule };

function body(value: unknown): Body {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    refuse("form", formMessage);
  return value as Body;
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) refuse("form", formMessage);
  return value;
}

function fields<T>(value: unknown, rules: Rules<T>, scope: Scope): void {
  const ruleFor: Readonly<Record<string, Rule | undefined>> = rules;
  for (const [key, field] of Object.entries(body(value))) {
    const rule = ruleFor[key];
    if (rule === undefined) refuse("form", formMessage);
    if (rule === "location" || rule === "int") {
      if (!Number.isInteger(field)) refuse("form", formMessage);
    } else if (rule === "bool") {
      if (typeof field !== "boolean") refuse("form", formMessage);
    } else if (rule === "name") {
      if (typeof field !== "string") refuse("form", formMessage);
    } else if (rule === "expr") {
      expression(field, scope);
    } else if (rule === "exprs") {
      for (const item of list(field)) expression(item, scope);
    } else if (typeof rule === "function") {
      rule(field, scope);
    } else if (typeof field !== "string" || !rule.includes(field)) {
      refuse("form", formMessage);
    }
  }
}

function deeper(scope: Scope): Scope {
  if (scope.depth >= knowledgeSqlLimits.nesting) {
    refuse("too-large", "That statement is nested too deeply. Simplify it.", "resource_exhausted");
  }
  return { ...scope, depth: scope.depth + 1 };
}

function unwrap(value: unknown): readonly [string, unknown] {
  const entries = Object.entries(body(value));
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) refuse("form", formMessage);
  return entry;
}

function names(value: unknown): readonly string[] {
  return list(value).map((item) => {
    const [tag, inner] = unwrap(item);
    if (tag !== "String") refuse("form", formMessage);
    const fieldsOf = body(inner);
    const sval = fieldsOf.sval;
    if (
      Object.keys(fieldsOf).some((key) => key !== "sval") ||
      (sval !== undefined && typeof sval !== "string")
    ) {
      refuse("form", formMessage);
    }
    return sval ?? "";
  });
}

function builtinName(parts: readonly string[]): string | undefined {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && parts[0] === "pg_catalog") return parts[1];
  return undefined;
}

function shown(name: string | undefined, fallback: string): string {
  return name !== undefined && /^[a-z_][a-z0-9_]{0,62}(?:\.[a-z_][a-z0-9_]{0,62})?$/u.test(name)
    ? name
    : fallback;
}

function refuseWith(reason: KnowledgeSqlRefusalReason, message: string): (value: unknown) => never {
  return () => refuse(reason, message);
}

const relations = new Set(["facts", "fact_history"]);
const systemColumns = new Set(["tableoid", "ctid", "xmin", "xmax", "cmin", "cmax"]);
const collations = new Set(["C", "POSIX", "default", "ucs_basic"]);

const types = new Set([
  "text",
  "varchar",
  "bpchar",
  "bool",
  "int2",
  "int4",
  "int8",
  "numeric",
  "float4",
  "float8",
  "json",
  "jsonb",
  "uuid",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "interval",
]);

const operators = new Set([
  "=",
  "<>",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "|/",
  "@",
  "||",
  "~~",
  "!~~",
  "~~*",
  "!~~*",
  "~",
  "!~",
  "~*",
  "!~*",
  "->",
  "->>",
  "#>",
  "#>>",
  "@>",
  "<@",
  "?",
  "?|",
  "?&",
  "@?",
  "#-",
]);

const scalarFunctions = new Set([
  "lower",
  "upper",
  "length",
  "char_length",
  "btrim",
  "ltrim",
  "rtrim",
  "replace",
  "strpos",
  "concat",
  "concat_ws",
  "substring",
  "position",
  "overlay",
  "split_part",
  "left",
  "right",
  "lpad",
  "rpad",
  "initcap",
  "starts_with",
  "format",
  "regexp_replace",
  "regexp_match",
  "regexp_like",
  "to_char",
  "to_number",
  "to_date",
  "to_timestamp",
  "now",
  "date_trunc",
  "date_part",
  "extract",
  "timezone",
  "overlaps",
  "age",
  "date_bin",
  "make_date",
  "make_interval",
  "jsonb_typeof",
  "jsonb_array_length",
  "jsonb_build_object",
  "jsonb_build_array",
  "jsonb_extract_path",
  "jsonb_extract_path_text",
  "jsonb_path_query_first",
  "jsonb_path_query_array",
  "jsonb_path_exists",
  "jsonb_set",
  "jsonb_strip_nulls",
  "to_jsonb",
  "jsonb_pretty",
  "array_length",
  "cardinality",
  "array_position",
  "array_to_string",
  "round",
  "abs",
  "ceil",
  "floor",
  "trunc",
  "power",
  "sqrt",
  "mod",
  "sign",
]);
const aggregateFunctions = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "jsonb_agg",
  "jsonb_object_agg",
  "string_agg",
  "array_agg",
  "bool_and",
  "bool_or",
  "every",
  "stddev",
]);
const orderedSetAggregates = new Set(["percentile_cont", "percentile_disc", "mode"]);
const windowFunctions = new Set([
  "row_number",
  "rank",
  "dense_rank",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "ntile",
]);
const setReturningFunctions = new Set([
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_each",
  "jsonb_each_text",
  "jsonb_object_keys",
  "jsonb_path_query",
  "regexp_matches",
  "unnest",
]);

const dateTimeValueFunctions = [
  "SVFOP_CURRENT_DATE",
  "SVFOP_CURRENT_TIME",
  "SVFOP_CURRENT_TIME_N",
  "SVFOP_CURRENT_TIMESTAMP",
  "SVFOP_CURRENT_TIMESTAMP_N",
  "SVFOP_LOCALTIME",
  "SVFOP_LOCALTIME_N",
  "SVFOP_LOCALTIMESTAMP",
  "SVFOP_LOCALTIMESTAMP_N",
] as const;
const identityValueFunctions: Readonly<Record<string, string>> = {
  SVFOP_CURRENT_ROLE: "current_role",
  SVFOP_CURRENT_USER: "current_user",
  SVFOP_USER: "user",
  SVFOP_SESSION_USER: "session_user",
  SVFOP_CURRENT_CATALOG: "current_catalog",
  SVFOP_CURRENT_SCHEMA: "current_schema",
};

const refusedForms: Readonly<Record<string, string>> = {
  XmlExpr: "XML functions aren't allowed.",
  XmlSerialize: "XML functions aren't allowed.",
  RangeTableFunc: "XMLTABLE isn't allowed.",
  RangeTableSample: "TABLESAMPLE isn't allowed.",
  NamedArgExpr: "Named function arguments aren't allowed. Pass arguments by position.",
  SetToDefault: "DEFAULT isn't allowed. Give each column a value.",
};

function checkOperator(parts: readonly string[], allowed: ReadonlySet<string> = operators): void {
  const name = builtinName(parts);
  if (name === undefined || !allowed.has(name)) {
    const display =
      name !== undefined && /^[-+*/<>=~!@#%^&|`?]{1,63}$/u.test(name) ? name : undefined;
    refuse(
      "operator",
      display === undefined
        ? "That operator isn't allowed."
        : `The ${display} operator isn't allowed.`,
    );
  }
}

function checkType(value: unknown, scope: Scope): void {
  fields<TypeName>(
    value,
    {
      names: (field) => {
        const parts = names(field);
        const name = builtinName(parts);
        if (name === undefined || !types.has(name)) {
          refuse(
            "type",
            `${shown(name ?? parts.join("."), "That type")} isn't an allowed type. Cast to text, numeric, int4, float8, bool, jsonb, timestamptz or another common type.`,
          );
        }
      },
      typmods: (field) => {
        for (const item of list(field)) {
          const [tag, inner] = unwrap(item);
          if (tag !== "A_Const" || body(inner).ival === undefined) refuse("form", formMessage);
          constant(inner);
        }
      },
      typemod: "int",
      arrayBounds: (field) => {
        for (const item of list(field)) {
          const [tag, inner] = unwrap(item);
          if (tag !== "Integer") refuse("form", formMessage);
          fields<{ ival: number }>(inner, { ival: "int" }, scope);
        }
      },
      location: "location",
    },
    scope,
  );
}

function constant(value: unknown): void {
  const scope: Scope = { ctes: new Set(), depth: 0, parameters: [] };
  fields<A_Const>(
    value,
    {
      ival: (field) => fields<{ ival: number }>(field, { ival: "int" }, scope),
      fval: (field) => fields<{ fval: string }>(field, { fval: "name" }, scope),
      boolval: (field) => fields<{ boolval: boolean }>(field, { boolval: "bool" }, scope),
      sval: (field) => fields<{ sval: string }>(field, { sval: "name" }, scope),
      isnull: "bool",
      location: "location",
    },
    scope,
  );
}

function stringConstant(value: unknown): string | undefined {
  const [tag, inner] = unwrap(value);
  if (tag !== "A_Const") return undefined;
  constant(inner);
  const sval = body(inner).sval;
  if (sval === undefined) return undefined;
  const text = body(sval).sval;
  return typeof text === "string" ? text : "";
}

function alias(value: unknown, scope: Scope): void {
  fields<Alias>(value, { aliasname: "name", colnames: (field) => void names(field) }, scope);
}

function columnName(name: string): void {
  if (systemColumns.has(name)) refuse("relation", `System columns aren't available. ${scopeHint}`);
}

function columnRef(value: unknown, scope: Scope): void {
  fields<ColumnRef>(
    value,
    {
      fields: (field) => {
        const items = list(field);
        if (items.length === 0 || items.length > 3) refuse("form", formMessage);
        items.forEach((item, index) => {
          const [tag, inner] = unwrap(item);
          if (tag === "A_Star" && index === items.length - 1) {
            fields(inner, {}, scope);
            return;
          }
          const [name] = names([item]);
          if (name !== undefined) columnName(name);
        });
      },
      location: "location",
    },
    scope,
  );
}

function functionCall(value: unknown, scope: Scope, position: "expression" | "from"): void {
  const call = body(value);
  const name = builtinName(names(call.funcname));
  const known =
    name !== undefined &&
    (position === "from"
      ? setReturningFunctions.has(name)
      : scalarFunctions.has(name) ||
        aggregateFunctions.has(name) ||
        orderedSetAggregates.has(name) ||
        windowFunctions.has(name) ||
        setReturningFunctions.has(name));
  if (name === undefined || !known) {
    refuse(
      "function",
      position === "from" && name !== undefined && scalarFunctions.has(name)
        ? `Only set-returning functions such as jsonb_array_elements can be used in FROM. ${scopeHint}`
        : `${shown(name, "That function")} isn't allowed. ${scopeHint}`,
    );
  }
  const aggregate = aggregateFunctions.has(name) || orderedSetAggregates.has(name);
  const aggregateOnly = (field: unknown) => {
    if (!aggregate)
      refuse("form", `${name} isn't an aggregate, so it can't take ORDER BY, FILTER or DISTINCT.`);
    return field;
  };
  if (orderedSetAggregates.has(name) !== (call.agg_within_group === true)) {
    refuse("form", "WITHIN GROUP is only for percentile_cont, percentile_disc and mode.");
  }
  fields<FuncCall>(
    call,
    {
      funcname: () => undefined,
      args: "exprs",
      agg_order: (field, inner) => sortList(aggregateOnly(field), inner),
      agg_filter: (field, inner) => expression(aggregateOnly(field), inner),
      agg_within_group: "bool",
      agg_star: (field) => {
        if (name !== "count" || field !== true) refuse("form", formMessage);
      },
      agg_distinct: (field) => {
        if (aggregateOnly(field) !== true) refuse("form", formMessage);
      },
      over: (field, inner) => {
        if (position === "from" || !(aggregate || windowFunctions.has(name))) {
          refuse("form", `${name} can't be used with OVER.`);
        }
        windowDefinition(field, inner);
      },
      func_variadic: refuseWith("form", "VARIADIC isn't allowed. Pass arguments one by one."),
      funcformat: ["COERCE_EXPLICIT_CALL", "COERCE_SQL_SYNTAX"],
      location: "location",
    },
    scope,
  );
}

function windowDefinition(value: unknown, scope: Scope): void {
  fields<WindowDef>(
    value,
    {
      name: refuseWith("form", "Named windows aren't allowed. Write the window inside OVER (...)."),
      refname: refuseWith(
        "form",
        "Named windows aren't allowed. Write the window inside OVER (...).",
      ),
      partitionClause: "exprs",
      orderClause: sortList,
      frameOptions: "int",
      startOffset: "expr",
      endOffset: "expr",
      location: "location",
    },
    scope,
  );
}

function sortList(value: unknown, scope: Scope): void {
  for (const item of list(value)) {
    const [tag, inner] = unwrap(item);
    if (tag !== "SortBy") refuse("form", formMessage);
    const using = body(inner).sortby_dir === "SORTBY_USING";
    fields<SortBy>(
      inner,
      {
        node: "expr",
        sortby_dir: ["SORTBY_DEFAULT", "SORTBY_ASC", "SORTBY_DESC", "SORTBY_USING"],
        sortby_nulls: ["SORTBY_NULLS_DEFAULT", "SORTBY_NULLS_FIRST", "SORTBY_NULLS_LAST"],
        useOp: (field) => {
          if (!using) refuse("form", formMessage);
          checkOperator(names(field), new Set(["<", ">"]));
        },
        location: "location",
      },
      scope,
    );
    if (using && body(inner).useOp === undefined) refuse("form", formMessage);
  }
}

const listParameterMessage =
  "Parameters arrive as JSON, never as PostgreSQL arrays. Send a list as a JSON array and read it with jsonb_array_elements_text($1::jsonb), as in thing IN (SELECT jsonb_array_elements_text($1::jsonb)).";

function paramRef(value: unknown, scope: Scope): void {
  fields<ParamRef>(
    value,
    {
      number: (field) => {
        if (
          typeof field !== "number" ||
          !Number.isInteger(field) ||
          field < 1 ||
          field > scope.parameters.length
        ) {
          refuse(
            "parameter",
            "The statement uses a parameter that wasn't sent. Number parameters $1, $2, ... in the order you send them.",
          );
        }
      },
      location: "location",
    },
    scope,
  );
}

function aExpr(value: unknown, scope: Scope): void {
  const expr = body(value);
  const parts = names(expr.name);
  const kind = expr.kind;
  const exact = (...allowed: string[]) => {
    if (parts.length !== 1 || !allowed.includes(parts[0] ?? "")) refuse("form", formMessage);
  };
  let rexpr: Rule = "expr";
  switch (kind) {
    case "AEXPR_OP":
    case "AEXPR_OP_ANY":
    case "AEXPR_OP_ALL":
      checkOperator(parts);
      if (kind !== "AEXPR_OP" && unwrap(expr.rexpr)[0] === "ParamRef")
        refuse("parameter", listParameterMessage);
      break;
    case "AEXPR_DISTINCT":
    case "AEXPR_NOT_DISTINCT":
    case "AEXPR_NULLIF":
      exact("=");
      break;
    case "AEXPR_IN":
      exact("=", "<>");
      rexpr = (field, inner) => expressionList(field, inner);
      break;
    case "AEXPR_LIKE":
      exact("~~", "!~~");
      rexpr = escapeHelper("like_escape");
      break;
    case "AEXPR_ILIKE":
      exact("~~*", "!~~*");
      rexpr = escapeHelper("like_escape");
      break;
    case "AEXPR_SIMILAR":
      exact("~", "!~");
      rexpr = escapeHelper("similar_to_escape");
      break;
    case "AEXPR_BETWEEN":
    case "AEXPR_NOT_BETWEEN":
    case "AEXPR_BETWEEN_SYM":
    case "AEXPR_NOT_BETWEEN_SYM":
      exact("BETWEEN", "NOT BETWEEN", "BETWEEN SYMMETRIC", "NOT BETWEEN SYMMETRIC");
      rexpr = (field, inner) => expressionList(field, inner, 2);
      break;
    default:
      refuse("form", formMessage);
  }
  fields<A_Expr>(
    expr,
    { kind: () => undefined, name: () => undefined, lexpr: "expr", rexpr, location: "location" },
    scope,
  );
}

function expressionList(value: unknown, scope: Scope, length?: number): void {
  const [tag, inner] = unwrap(value);
  if (tag !== "List") {
    expression(value, scope);
    return;
  }
  fields<{ items: unknown }>(
    inner,
    {
      items: (field, nested) => {
        const items = list(field);
        if (length !== undefined && items.length !== length) refuse("form", formMessage);
        for (const item of items) expression(item, nested);
      },
    },
    scope,
  );
}

function escapeHelper(helper: string): Rule {
  return (value, scope) => {
    const [tag, inner] = unwrap(value);
    const call = tag === "FuncCall" ? body(inner) : undefined;
    if (call === undefined || names(call.funcname).join(".") !== `pg_catalog.${helper}`) {
      expression(value, scope);
      return;
    }
    fields<FuncCall>(
      call,
      {
        funcname: () => undefined,
        args: "exprs",
        funcformat: ["COERCE_EXPLICIT_CALL"],
        location: "location",
      },
      deeper(scope),
    );
  };
}

function subLink(value: unknown, scope: Scope): void {
  fields<SubLink>(
    value,
    {
      subLinkType: [
        "EXISTS_SUBLINK",
        "ALL_SUBLINK",
        "ANY_SUBLINK",
        "ROWCOMPARE_SUBLINK",
        "EXPR_SUBLINK",
        "ARRAY_SUBLINK",
      ],
      testexpr: "expr",
      operName: (field) => checkOperator(names(field)),
      subselect: wrappedSelect,
      location: "location",
    },
    scope,
  );
}

function jsonFormat(value: unknown, scope: Scope): void {
  fields<JsonFormat>(
    value,
    {
      format_type: ["JS_FORMAT_DEFAULT", "JS_FORMAT_JSON", "JS_FORMAT_JSONB"],
      encoding: ["JS_ENC_DEFAULT", "JS_ENC_UTF8"],
      location: "location",
    },
    scope,
  );
}

function jsonValue(value: unknown, scope: Scope): void {
  fields<JsonValueExpr>(value, { raw_expr: "expr", format: jsonFormat }, scope);
}

function jsonOutput(value: unknown, scope: Scope): void {
  fields<JsonOutput>(
    value,
    {
      typeName: checkType,
      returning: (field, inner) => fields<JsonReturning>(field, { format: jsonFormat }, inner),
    },
    scope,
  );
}

function jsonBehavior(value: unknown, scope: Scope): void {
  fields<JsonBehavior>(
    value,
    {
      btype: [
        "JSON_BEHAVIOR_NULL",
        "JSON_BEHAVIOR_ERROR",
        "JSON_BEHAVIOR_EMPTY",
        "JSON_BEHAVIOR_TRUE",
        "JSON_BEHAVIOR_FALSE",
        "JSON_BEHAVIOR_UNKNOWN",
        "JSON_BEHAVIOR_EMPTY_ARRAY",
        "JSON_BEHAVIOR_EMPTY_OBJECT",
        "JSON_BEHAVIOR_DEFAULT",
      ],
      expr: "expr",
      coerce: "bool",
      location: "location",
    },
    scope,
  );
}

function jsonPassing(value: unknown, scope: Scope): void {
  for (const item of list(value)) {
    const [tag, inner] = unwrap(item);
    if (tag !== "JsonArgument") refuse("form", formMessage);
    fields<JsonArgument>(inner, { val: jsonValue, name: "name" }, scope);
  }
}

function jsonAggregate(value: unknown, scope: Scope): void {
  fields<JsonAggConstructor>(
    value,
    {
      output: jsonOutput,
      agg_filter: "expr",
      agg_order: sortList,
      over: windowDefinition,
      location: "location",
    },
    scope,
  );
}

function jsonKeyValue(value: unknown, scope: Scope): void {
  fields<JsonKeyValue>(value, { key: "expr", value: jsonValue }, scope);
}

const jsonWrappers = ["JSW_UNSPEC", "JSW_NONE", "JSW_CONDITIONAL", "JSW_UNCONDITIONAL"];
const jsonQuotes = ["JS_QUOTES_UNSPEC", "JS_QUOTES_KEEP", "JS_QUOTES_OMIT"];

const expressions: Readonly<Record<string, (value: unknown, scope: Scope) => void>> = {
  A_Const: (value) => constant(value),
  ColumnRef: columnRef,
  ParamRef: paramRef,
  A_Expr: aExpr,
  BoolExpr: (value, scope) =>
    fields<BoolExpr>(
      value,
      { boolop: ["AND_EXPR", "OR_EXPR", "NOT_EXPR"], args: "exprs", location: "location" },
      scope,
    ),
  NullTest: (value, scope) =>
    fields<NullTest>(
      value,
      { arg: "expr", nulltesttype: ["IS_NULL", "IS_NOT_NULL"], location: "location" },
      scope,
    ),
  BooleanTest: (value, scope) =>
    fields<BooleanTest>(
      value,
      {
        arg: "expr",
        booltesttype: [
          "IS_TRUE",
          "IS_NOT_TRUE",
          "IS_FALSE",
          "IS_NOT_FALSE",
          "IS_UNKNOWN",
          "IS_NOT_UNKNOWN",
        ],
        location: "location",
      },
      scope,
    ),
  TypeCast: (value, scope) => {
    const cast = body(value);
    if (unwrap(cast.arg)[0] === "ParamRef" && body(cast.typeName).arrayBounds !== undefined)
      refuse("parameter", listParameterMessage);
    fields<TypeCast>(value, { arg: "expr", typeName: checkType, location: "location" }, scope);
  },
  FuncCall: (value, scope) => functionCall(value, scope, "expression"),
  SubLink: subLink,
  CaseExpr: (value, scope) =>
    fields<CaseExpr>(
      value,
      {
        arg: "expr",
        args: (field, inner) => {
          for (const item of list(field)) {
            const [tag, when] = unwrap(item);
            if (tag !== "CaseWhen") refuse("form", formMessage);
            fields<CaseWhen>(
              when,
              { expr: "expr", result: "expr", location: "location" },
              deeper(inner),
            );
          }
        },
        defresult: "expr",
        location: "location",
      },
      scope,
    ),
  CoalesceExpr: (value, scope) =>
    fields<CoalesceExpr>(value, { args: "exprs", location: "location" }, scope),
  MinMaxExpr: (value, scope) =>
    fields<MinMaxExpr>(
      value,
      { op: ["IS_GREATEST", "IS_LEAST"], args: "exprs", location: "location" },
      scope,
    ),
  RowExpr: (value, scope) =>
    fields<RowExpr>(
      value,
      {
        args: "exprs",
        row_format: ["COERCE_EXPLICIT_CALL", "COERCE_IMPLICIT_CAST"],
        location: "location",
      },
      scope,
    ),
  A_ArrayExpr: (value, scope) =>
    fields<A_ArrayExpr>(value, { elements: "exprs", location: "location" }, scope),
  A_Indirection: (value, scope) =>
    fields<A_Indirection>(
      value,
      {
        arg: "expr",
        indirection: (field, inner) => {
          for (const item of list(field)) {
            const [tag, part] = unwrap(item);
            if (tag === "String") {
              const [name] = names([item]);
              if (name !== undefined) columnName(name);
            } else if (tag === "A_Star") {
              fields(part, {}, inner);
            } else if (tag === "A_Indices") {
              fields<A_Indices>(
                part,
                { is_slice: "bool", lidx: "expr", uidx: "expr" },
                deeper(inner),
              );
            } else {
              refuse("form", formMessage);
            }
          }
        },
      },
      scope,
    ),
  CollateClause: (value, scope) =>
    fields<CollateClause>(
      value,
      {
        arg: "expr",
        collname: (field) => {
          const name = builtinName(names(field));
          if (name === undefined || !collations.has(name)) {
            refuse(
              "form",
              'Only the "C", "POSIX", "default" and "ucs_basic" collations are allowed.',
            );
          }
        },
        location: "location",
      },
      scope,
    ),
  SQLValueFunction: (value, scope) => {
    const op = body(value).op;
    const identity = typeof op === "string" ? identityValueFunctions[op] : undefined;
    if (identity !== undefined) refuse("function", `${identity} isn't allowed. ${scopeHint}`);
    fields<SQLValueFunction>(
      value,
      { op: dateTimeValueFunctions, typmod: "int", location: "location" },
      scope,
    );
  },
  GroupingFunc: (value, scope) =>
    fields<GroupingFunc>(value, { args: "exprs", location: "location" }, scope),
  JsonObjectConstructor: (value, scope) =>
    fields<JsonObjectConstructor>(
      value,
      {
        exprs: (field, inner) => {
          for (const item of list(field)) {
            const [tag, pair] = unwrap(item);
            if (tag !== "JsonKeyValue") refuse("form", formMessage);
            jsonKeyValue(pair, deeper(inner));
          }
        },
        output: jsonOutput,
        absent_on_null: "bool",
        unique: "bool",
        location: "location",
      },
      scope,
    ),
  JsonArrayConstructor: (value, scope) =>
    fields<JsonArrayConstructor>(
      value,
      {
        exprs: (field, inner) => {
          for (const item of list(field)) {
            const [tag, element] = unwrap(item);
            if (tag !== "JsonValueExpr") refuse("form", formMessage);
            jsonValue(element, deeper(inner));
          }
        },
        output: jsonOutput,
        absent_on_null: "bool",
        location: "location",
      },
      scope,
    ),
  JsonArrayQueryConstructor: (value, scope) =>
    fields<JsonArrayQueryConstructor>(
      value,
      {
        query: wrappedSelect,
        output: jsonOutput,
        format: jsonFormat,
        absent_on_null: "bool",
        location: "location",
      },
      scope,
    ),
  JsonObjectAgg: (value, scope) =>
    fields<JsonObjectAgg>(
      value,
      { constructor: jsonAggregate, arg: jsonKeyValue, absent_on_null: "bool", unique: "bool" },
      scope,
    ),
  JsonArrayAgg: (value, scope) =>
    fields<JsonArrayAgg>(
      value,
      { constructor: jsonAggregate, arg: jsonValue, absent_on_null: "bool" },
      scope,
    ),
  JsonFuncExpr: (value, scope) =>
    fields<JsonFuncExpr>(
      value,
      {
        op: ["JSON_EXISTS_OP", "JSON_QUERY_OP", "JSON_VALUE_OP"],
        context_item: jsonValue,
        pathspec: "expr",
        passing: jsonPassing,
        output: jsonOutput,
        on_empty: jsonBehavior,
        on_error: jsonBehavior,
        wrapper: jsonWrappers,
        quotes: jsonQuotes,
        location: "location",
      },
      scope,
    ),
  JsonIsPredicate: (value, scope) =>
    fields<JsonIsPredicate>(
      value,
      {
        expr: "expr",
        format: jsonFormat,
        item_type: ["JS_TYPE_ANY", "JS_TYPE_OBJECT", "JS_TYPE_ARRAY", "JS_TYPE_SCALAR"],
        unique_keys: "bool",
        location: "location",
      },
      scope,
    ),
  JsonParseExpr: (value, scope) =>
    fields<JsonParseExpr>(
      value,
      { expr: jsonValue, output: jsonOutput, unique_keys: "bool", location: "location" },
      scope,
    ),
  JsonScalarExpr: (value, scope) =>
    fields<JsonScalarExpr>(
      value,
      { expr: "expr", output: jsonOutput, location: "location" },
      scope,
    ),
  JsonSerializeExpr: (value, scope) =>
    fields<JsonSerializeExpr>(
      value,
      { expr: jsonValue, output: jsonOutput, location: "location" },
      scope,
    ),
};

function dispatch(
  value: unknown,
  scope: Scope,
  handlers: Readonly<Record<string, (value: unknown, scope: Scope) => void>>,
): void {
  const [tag, inner] = unwrap(value);
  const handler = handlers[tag];
  if (handler === undefined) refuse("form", refusedForms[tag] ?? formMessage);
  handler(inner, deeper(scope));
}

function expression(value: unknown, scope: Scope): void {
  dispatch(value, scope, expressions);
}

function pathSpec(value: unknown, scope: Scope): void {
  fields<JsonTablePathSpec>(
    value,
    { string: "expr", name: "name", name_location: "location", location: "location" },
    scope,
  );
}

function jsonTableColumns(value: unknown, scope: Scope): void {
  for (const item of list(value)) {
    const [tag, column] = unwrap(item);
    if (tag !== "JsonTableColumn") refuse("form", formMessage);
    fields<JsonTableColumn>(
      column,
      {
        coltype: ["JTC_FOR_ORDINALITY", "JTC_REGULAR", "JTC_EXISTS", "JTC_FORMATTED", "JTC_NESTED"],
        name: "name",
        typeName: checkType,
        pathspec: pathSpec,
        format: jsonFormat,
        wrapper: jsonWrappers,
        quotes: jsonQuotes,
        columns: jsonTableColumns,
        on_empty: jsonBehavior,
        on_error: jsonBehavior,
        location: "location",
      },
      deeper(scope),
    );
  }
}

function relation(value: unknown, scope: Scope): void {
  const range = body(value);
  const schema = range.schemaname;
  const name = range.relname;
  const allowed =
    typeof name === "string" &&
    range.catalogname === undefined &&
    (schema === "knowledge"
      ? relations.has(name)
      : schema === undefined && (relations.has(name) || scope.ctes.has(name)));
  if (!allowed) {
    refuse(
      "relation",
      `${shown([range.catalogname, schema, name].filter((part) => part !== undefined).join("."), "That relation")} isn't available. ${scopeHint}`,
    );
  }
  fields<RangeVar>(
    range,
    {
      catalogname: () => undefined,
      schemaname: () => undefined,
      relname: () => undefined,
      inh: "bool",
      relpersistence: ["p"],
      alias,
      location: "location",
    },
    scope,
  );
}

const fromItems: Readonly<Record<string, (value: unknown, scope: Scope) => void>> = {
  RangeVar: relation,
  JoinExpr: (value, scope) =>
    fields<JoinExpr>(
      value,
      {
        jointype: ["JOIN_INNER", "JOIN_LEFT", "JOIN_FULL", "JOIN_RIGHT"],
        isNatural: "bool",
        larg: fromItem,
        rarg: fromItem,
        usingClause: (field) => void names(field),
        join_using_alias: alias,
        quals: "expr",
        alias,
      },
      scope,
    ),
  RangeSubselect: (value, scope) =>
    fields<RangeSubselect>(value, { lateral: "bool", subquery: wrappedSelect, alias }, scope),
  RangeFunction: (value, scope) =>
    fields<RangeFunction>(
      value,
      {
        lateral: "bool",
        ordinality: "bool",
        is_rowsfrom: refuseWith("form", "ROWS FROM isn't allowed. Call one function in FROM."),
        functions: (field, inner) => {
          const items = list(field);
          if (items.length !== 1) refuse("form", formMessage);
          for (const item of items) {
            const [tag, pair] = unwrap(item);
            if (tag !== "List") refuse("form", formMessage);
            const [call, columns, ...rest] = list(body(pair).items);
            if (rest.length > 0 || Object.keys(body(pair)).length !== 1)
              refuse("form", formMessage);
            if (columns !== undefined && Object.keys(body(columns)).length > 0) {
              refuse("form", "Column definition lists aren't allowed in FROM.");
            }
            const [callTag, callBody] = unwrap(call);
            if (callTag !== "FuncCall") refuse("form", formMessage);
            functionCall(callBody, deeper(inner), "from");
          }
        },
        alias,
        coldeflist: refuseWith("form", "Column definition lists aren't allowed in FROM."),
      },
      scope,
    ),
  JsonTable: (value, scope) =>
    fields<JsonTable>(
      value,
      {
        context_item: jsonValue,
        pathspec: pathSpec,
        passing: jsonPassing,
        columns: jsonTableColumns,
        on_error: jsonBehavior,
        alias,
        lateral: "bool",
        location: "location",
      },
      scope,
    ),
};

function fromItem(value: unknown, scope: Scope): void {
  dispatch(value, scope, fromItems);
}

function targetList(value: unknown, scope: Scope): void {
  for (const item of list(value)) {
    const [tag, target] = unwrap(item);
    if (tag !== "ResTarget") refuse("form", formMessage);
    fields<ResTarget>(target, { name: "name", val: "expr", location: "location" }, deeper(scope));
  }
}

function groupList(value: unknown, scope: Scope): void {
  for (const item of list(value)) {
    const [tag, inner] = unwrap(item);
    if (tag !== "GroupingSet") {
      expression(item, scope);
      continue;
    }
    fields<GroupingSet>(
      inner,
      {
        kind: [
          "GROUPING_SET_EMPTY",
          "GROUPING_SET_SIMPLE",
          "GROUPING_SET_ROLLUP",
          "GROUPING_SET_CUBE",
          "GROUPING_SET_SETS",
        ],
        content: groupList,
        location: "location",
      },
      deeper(scope),
    );
  }
}

function valuesLists(value: unknown, scope: Scope): void {
  for (const row of list(value)) expressionList(row, scope);
}

function withClause(value: unknown, scope: Scope): Scope {
  const clause = body(value);
  if (clause.recursive === true) refuse("form", "Recursive CTEs aren't allowed.");
  const ctes = new Set(scope.ctes);
  fields<WithClause>(
    clause,
    {
      ctes: (field) => {
        for (const item of list(field)) {
          const [tag, inner] = unwrap(item);
          if (tag !== "CommonTableExpr") refuse("form", formMessage);
          const cte = body(inner);
          fields<CommonTableExpr>(
            cte,
            {
              ctename: "name",
              aliascolnames: (columns) => void names(columns),
              ctematerialized: [
                "CTEMaterializeDefault",
                "CTEMaterializeAlways",
                "CTEMaterializeNever",
              ],
              ctequery: (query, nested) => {
                const [queryTag] = unwrap(query);
                if (queryTag !== "SelectStmt")
                  refuse("form", "Only SELECT is allowed inside WITH.");
                wrappedSelect(query, nested);
              },
              location: "location",
            },
            deeper({ ...scope, ctes: new Set(ctes) }),
          );
          if (typeof cte.ctename === "string") ctes.add(cte.ctename);
        }
      },
      recursive: "bool",
      location: "location",
    },
    scope,
  );
  return { ...scope, ctes };
}

function wrappedSelect(value: unknown, scope: Scope): void {
  const [tag, inner] = unwrap(value);
  if (tag !== "SelectStmt") refuse("form", formMessage);
  select(inner, deeper(scope));
}

function select(value: unknown, outer: Scope): void {
  const statement = body(value);
  const scope =
    statement.withClause === undefined ? outer : withClause(statement.withClause, outer);
  fields<SelectStmt>(
    statement,
    {
      distinctClause: (field, inner) => {
        const items = list(field);
        const plain = items.length === 1 && Object.keys(body(items[0])).length === 0;
        if (!plain) for (const item of items) expression(item, inner);
      },
      intoClause: refuseWith("form", "SELECT INTO isn't allowed."),
      targetList,
      fromClause: (field, inner) => {
        for (const item of list(field)) fromItem(item, inner);
      },
      whereClause: "expr",
      groupClause: groupList,
      groupDistinct: "bool",
      havingClause: "expr",
      windowClause: refuseWith(
        "form",
        "Named windows aren't allowed. Write the window inside OVER (...).",
      ),
      valuesLists,
      sortClause: sortList,
      limitOffset: "expr",
      limitCount: "expr",
      limitOption: ["LIMIT_OPTION_DEFAULT", "LIMIT_OPTION_COUNT", "LIMIT_OPTION_WITH_TIES"],
      lockingClause: refuseWith("form", "Row locks such as FOR UPDATE aren't allowed."),
      withClause: () => undefined,
      op: ["SETOP_NONE", "SETOP_UNION", "SETOP_INTERSECT", "SETOP_EXCEPT"],
      all: "bool",
      larg: (field, inner) => select(field, deeper(inner)),
      rarg: (field, inner) => select(field, deeper(inner)),
    },
    scope,
  );
}

const writableColumns = new Set(["topic", "thing", "property", "value", "seen_fact_id"]);
const keyColumns = ["topic", "thing", "property"] as const;
const insertColumnsMessage =
  "INSERT INTO facts names its columns: topic, thing, property, value and optionally seen_fact_id. The server fills the writer columns.";
const insertValuesMessage = `Use INSERT INTO facts (...) VALUES with 1 to ${knowledgeSqlLimits.insertRows} rows. INSERT ... SELECT isn't allowed.`;

function insert(
  value: unknown,
  scope: Scope,
): Omit<Extract<KnowledgeSqlAdmission, { kind: "insert" }>, "text"> {
  const statement = body(value);
  const columns: string[] = [];
  let rows: readonly unknown[] = [];
  fields<InsertStmt>(
    statement,
    {
      relation: (field, inner) => {
        const range = body(field);
        if (
          range.relname !== "facts" ||
          (range.schemaname !== undefined && range.schemaname !== "knowledge")
        ) {
          refuse("relation", "You can only INSERT INTO facts.");
        }
        relation(field, { ...inner, ctes: new Set() });
      },
      cols: (field) => {
        for (const item of list(field)) {
          const [tag, target] = unwrap(item);
          if (tag !== "ResTarget") refuse("insert", insertColumnsMessage);
          const name = body(target).name;
          fields<ResTarget>(target, { name: "name", location: "location" }, scope);
          if (typeof name !== "string" || !writableColumns.has(name) || columns.includes(name)) {
            refuse("insert", insertColumnsMessage);
          }
          columns.push(name);
        }
      },
      selectStmt: (field) => {
        const [tag, inner] = unwrap(field);
        const values = body(inner);
        if (
          tag !== "SelectStmt" ||
          values.op !== "SETOP_NONE" ||
          Object.keys(values).some((key) => !["valuesLists", "limitOption", "op"].includes(key))
        ) {
          refuse("insert", insertValuesMessage);
        }
        fields<SelectStmt>(
          inner,
          {
            valuesLists: (lists) => {
              rows = list(lists);
            },
            limitOption: ["LIMIT_OPTION_DEFAULT"],
            op: ["SETOP_NONE"],
          },
          scope,
        );
      },
      returningList: (field, inner) => {
        for (const item of list(field)) {
          const [tag, target] = unwrap(item);
          if (tag !== "ResTarget") refuse("insert", formMessage);
          fields<ResTarget>(
            target,
            {
              name: "name",
              val: (column, nested) => {
                const [columnTag, ref] = unwrap(column);
                if (columnTag !== "ColumnRef") {
                  refuse(
                    "insert",
                    "RETURNING can only name columns of facts. The receipt reports what was written.",
                  );
                }
                columnRef(ref, nested);
              },
              location: "location",
            },
            deeper(inner),
          );
        }
      },
      withClause: refuseWith(
        "insert",
        "WITH isn't allowed on INSERT. Read first, then insert the values.",
      ),
      onConflictClause: refuseWith(
        "insert",
        "ON CONFLICT isn't allowed. Facts are appended; a newer row replaces an older one.",
      ),
      override: (field) => {
        if (field !== "OVERRIDING_NOT_SET") refuse("insert", "OVERRIDING isn't allowed.");
      },
    },
    scope,
  );
  if (keyColumns.some((column) => !columns.includes(column)) || !columns.includes("value")) {
    refuse("insert", insertColumnsMessage);
  }
  if (rows.length === 0 || rows.length > knowledgeSqlLimits.insertRows)
    refuse("insert", insertValuesMessage);
  const keys = rows.map((row) => {
    const [tag, inner] = unwrap(row);
    const items = tag === "List" ? list(body(inner).items) : [];
    if (
      tag !== "List" ||
      Object.keys(body(inner)).length !== 1 ||
      items.length !== columns.length
    ) {
      refuse("insert", "Each VALUES row needs one value for each named column.");
    }
    const key: Record<string, string> = {};
    items.forEach((item, index) => {
      const column = columns[index] ?? "";
      if (!(keyColumns as readonly string[]).includes(column)) {
        expression(item, deeper(scope));
        return;
      }
      key[column] = keyText(item, scope);
    });
    return { topic: key.topic ?? "", thing: key.thing ?? "", property: key.property ?? "" };
  });
  return {
    kind: "insert",
    rowCount: keys.length,
    topicIds: [...new Set(keys.map((key) => key.topic))].sort(),
    keys,
    suppliesBaseline: columns.includes("seen_fact_id"),
  };
}

function keyText(value: unknown, scope: Scope): string {
  const message = "Give topic, thing and property as text literals or text parameters.";
  const [tag, inner] = unwrap(value);
  if (tag === "ParamRef") {
    paramRef(inner, scope);
    const parameter = scope.parameters[Number(body(inner).number) - 1];
    if (typeof parameter !== "string") refuse("insert", message);
    return parameter;
  }
  const text = stringConstant(value);
  if (text === undefined) refuse("insert", message);
  return text;
}

function admitTree(tree: unknown, input: KnowledgeSqlInput): KnowledgeSqlAdmission {
  const scope: Scope = { ctes: new Set(), depth: 0, parameters: input.parameters };
  let statement: unknown;
  let location = 0;
  let length = 0;
  fields<{ version: number; stmts: unknown }>(
    tree,
    {
      version: "int",
      stmts: (field) => {
        const statements = list(field);
        if (statements.length !== 1) refuse("statement", statementMessage);
        fields<RawStmt>(
          statements[0],
          {
            stmt: (value) => {
              statement = value;
            },
            stmt_location: (value) => {
              location = Number(value);
            },
            stmt_len: (value) => {
              length = Number(value);
            },
          },
          scope,
        );
      },
    },
    scope,
  );
  const bytes = Buffer.from(input.text, "utf8");
  const text = `${bytes
    .subarray(location, length === 0 ? undefined : location + length)
    .toString("utf8")
    .trim()}\n`;
  const [tag, inner] = unwrap(statement);
  if (tag === "SelectStmt") {
    select(inner, deeper(scope));
    return { kind: "select", text };
  }
  if (tag === "InsertStmt") return { ...insert(inner, deeper(scope)), text };
  return refuse("statement", statementMessage);
}
