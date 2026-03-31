import path from "node:path";
import type { DatabaseSync as NodeSqliteDatabaseSync } from "node:sqlite";

import type { NetworkQueryRecord, NetworkResourceType } from "@opensteer/protocol";

import { ensureDirectory } from "../internal/filesystem.js";

const TAG_DELIMITER = "\u001f";
const NODE_SQLITE_SPECIFIER = `node:${"sqlite"}`;
const SAVED_NETWORK_SQLITE_SUPPORT_ERROR =
  "Saved-network operations require Node's built-in SQLite support. Use a Node runtime with node:sqlite enabled.";

export interface SavedNetworkQueryInput {
  readonly pageRef?: NetworkQueryRecord["record"]["pageRef"];
  readonly recordId?: string;
  readonly requestId?: string;
  readonly capture?: string;
  readonly tag?: string;
  readonly url?: string;
  readonly hostname?: string;
  readonly path?: string;
  readonly method?: string;
  readonly status?: string;
  readonly resourceType?: NetworkResourceType;
  readonly includeBodies?: boolean;
  readonly limit?: number;
}

export type SavedNetworkBodyWriteMode = "authoritative" | "metadata-only";

export interface SavedNetworkSaveOptions {
  readonly bodyWriteMode: SavedNetworkBodyWriteMode;
  readonly tag?: string;
}

export interface SavedNetworkStore {
  readonly databasePath: string;

  initialize(): Promise<void>;
  save(records: readonly NetworkQueryRecord[], options: SavedNetworkSaveOptions): Promise<number>;
  tagByFilter(filter: SavedNetworkQueryInput, tag: string): Promise<number>;
  query(input?: SavedNetworkQueryInput): Promise<readonly NetworkQueryRecord[]>;
  getByRecordId(
    recordId: string,
    options?: { readonly includeBodies?: boolean },
  ): Promise<NetworkQueryRecord | undefined>;
  clear(input?: { readonly capture?: string; readonly tag?: string }): Promise<number>;
}

type SavedNetworkRow = {
  readonly record_id: string;
  readonly request_id: string;
  readonly session_ref: string;
  readonly page_ref: string | null;
  readonly frame_ref: string | null;
  readonly document_ref: string | null;
  readonly capture: string | null;
  readonly method: string;
  readonly url: string;
  readonly hostname: string;
  readonly path: string;
  readonly status: number | null;
  readonly status_text: string | null;
  readonly resource_type: string;
  readonly navigation_request: number;
  readonly request_headers_json: string;
  readonly response_headers_json: string;
  readonly request_body_json: string | null;
  readonly response_body_json: string | null;
  readonly initiator_json: string | null;
  readonly timing_json: string | null;
  readonly transfer_json: string | null;
  readonly source_json: string | null;
  readonly capture_state: string;
  readonly request_body_state: string;
  readonly response_body_state: string;
  readonly request_body_skip_reason: string | null;
  readonly response_body_skip_reason: string | null;
  readonly request_body_error: string | null;
  readonly response_body_error: string | null;
  readonly redirect_from_request_id: string | null;
  readonly redirect_to_request_id: string | null;
  readonly saved_at: number;
  readonly tags: string | null;
};

class SqliteSavedNetworkStore implements SavedNetworkStore {
  readonly databasePath: string;

  private database: NodeSqliteDatabaseSync | undefined;
  private directoryInitialization: Promise<void> | undefined;
  private databaseInitialization: Promise<NodeSqliteDatabaseSync> | undefined;

  constructor(rootPath: string) {
    this.databasePath = path.join(rootPath, "registry", "saved-network.sqlite");
  }

  async initialize(): Promise<void> {
    await this.ensureDatabaseDirectory();
  }

  async save(
    records: readonly NetworkQueryRecord[],
    options: SavedNetworkSaveOptions,
  ): Promise<number> {
    const database = await this.requireDatabase();
    const readExisting = database.prepare(`
        SELECT record_id
        FROM saved_network_records
        WHERE session_ref = @session_ref
          AND page_ref_key = @page_ref_key
          AND request_id = @request_id
      `);
    const upsertRecord = database.prepare(buildSavedNetworkUpsertSql(options.bodyWriteMode));
    const insertTag = database.prepare(`
      INSERT OR IGNORE INTO saved_network_tags (record_id, tag)
      VALUES (@record_id, @tag)
    `);

    return withSqliteTransaction(database, () => {
      let savedCount = 0;
      for (const entry of records) {
        const url = new URL(entry.record.url);
        const pageRefKey = entry.record.pageRef ?? "";
        const existing =
          (readExisting.get({
            session_ref: entry.record.sessionRef,
            page_ref_key: pageRefKey,
            request_id: entry.record.requestId,
          }) as { readonly record_id: string } | undefined) ?? undefined;
        const recordId = existing?.record_id ?? entry.recordId;

        upsertRecord.run({
          record_id: recordId,
          request_id: entry.record.requestId,
          session_ref: entry.record.sessionRef,
          page_ref: entry.record.pageRef ?? null,
          page_ref_key: pageRefKey,
          frame_ref: entry.record.frameRef ?? null,
          document_ref: entry.record.documentRef ?? null,
          capture: entry.capture ?? null,
          method: entry.record.method,
          method_lc: entry.record.method.toLowerCase(),
          url: entry.record.url,
          url_lc: entry.record.url.toLowerCase(),
          hostname: url.hostname,
          hostname_lc: url.hostname.toLowerCase(),
          path: url.pathname,
          path_lc: url.pathname.toLowerCase(),
          status: entry.record.status ?? null,
          status_text: entry.record.statusText ?? null,
          resource_type: entry.record.resourceType,
          navigation_request: entry.record.navigationRequest ? 1 : 0,
          request_headers_json: JSON.stringify(entry.record.requestHeaders),
          response_headers_json: JSON.stringify(entry.record.responseHeaders),
          request_body_json: stringifyOptional(entry.record.requestBody),
          response_body_json: stringifyOptional(entry.record.responseBody),
          initiator_json: stringifyOptional(entry.record.initiator),
          timing_json: stringifyOptional(entry.record.timing),
          transfer_json: stringifyOptional(entry.record.transfer),
          source_json: stringifyOptional(entry.record.source),
          capture_state: entry.record.captureState ?? "complete",
          request_body_state:
            entry.record.requestBodyState ??
            (entry.record.requestBody === undefined ? "skipped" : "complete"),
          response_body_state:
            entry.record.responseBodyState ??
            (entry.record.responseBody === undefined ? "skipped" : "complete"),
          request_body_skip_reason: entry.record.requestBodySkipReason ?? null,
          response_body_skip_reason: entry.record.responseBodySkipReason ?? null,
          request_body_error: entry.record.requestBodyError ?? null,
          response_body_error: entry.record.responseBodyError ?? null,
          redirect_from_request_id: entry.record.redirectFromRequestId ?? null,
          redirect_to_request_id: entry.record.redirectToRequestId ?? null,
          saved_at: entry.savedAt ?? Date.now(),
        });

        const tags = new Set<string>(entry.tags ?? []);
        if (options.tag !== undefined) {
          tags.add(options.tag);
        }
        for (const currentTag of tags) {
          const result = insertTag.run({
            record_id: recordId,
            tag: currentTag,
          }) as { readonly changes?: number };
          savedCount += result.changes ?? 0;
        }
      }
      return savedCount;
    });
  }

  async tagByFilter(filter: SavedNetworkQueryInput, tag: string): Promise<number> {
    const database = await this.requireDatabase();
    const { whereSql, parameters } = buildSavedNetworkWhere(filter);
    const selectRecords = database.prepare(
      `
        SELECT r.record_id
        FROM saved_network_records r
        ${whereSql}
      `,
    );
    const insertTag = database.prepare(`
      INSERT OR IGNORE INTO saved_network_tags (record_id, tag)
      VALUES (@record_id, @tag)
    `);

    return withSqliteTransaction(database, () => {
      let taggedCount = 0;
      const rows = selectRecords.all(
        ...(parameters as readonly (string | number | null | Uint8Array)[]),
      );
      for (const row of rows) {
        const recordId = row.record_id;
        if (typeof recordId !== "string") {
          continue;
        }
        const result = insertTag.run({
          record_id: recordId,
          tag,
        }) as { readonly changes?: number };
        taggedCount += result.changes ?? 0;
      }
      return taggedCount;
    });
  }

  async query(input: SavedNetworkQueryInput = {}): Promise<readonly NetworkQueryRecord[]> {
    const database = await this.requireDatabase();
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const { whereSql, parameters } = buildSavedNetworkWhere(input);
    const rows = database
      .prepare(
        `
      SELECT
        r.*,
        GROUP_CONCAT(t.tag, '${TAG_DELIMITER}') AS tags
      FROM saved_network_records r
      LEFT JOIN saved_network_tags t
        ON t.record_id = r.record_id
      ${whereSql}
      GROUP BY r.record_id
      ORDER BY r.saved_at DESC, r.record_id ASC
      LIMIT ?
    `,
      )
      .all(
        ...(parameters as readonly (string | number | null | Uint8Array)[]),
        limit,
      ) as SavedNetworkRow[];

    return rows.map((row) => inflateSavedNetworkRow(row, input.includeBodies ?? false));
  }

  async getByRecordId(
    recordId: string,
    options: { readonly includeBodies?: boolean } = {},
  ): Promise<NetworkQueryRecord | undefined> {
    const [record] = await this.query({
      recordId,
      ...(options.includeBodies === undefined ? {} : { includeBodies: options.includeBodies }),
      limit: 1,
    });
    return record;
  }

  async clear(input: { readonly capture?: string; readonly tag?: string } = {}): Promise<number> {
    const database = await this.requireDatabase();
    const countAll = database.prepare(`SELECT COUNT(*) AS cleared FROM saved_network_records`);
    const deleteAllRecords = database.prepare(`DELETE FROM saved_network_records`);
    const { whereSql, parameters } = buildSavedNetworkWhere(input);
    const countFiltered = database.prepare(`
      SELECT COUNT(*) AS cleared
      FROM saved_network_records r
      ${whereSql}
    `);
    const deleteFiltered = database.prepare(`
      DELETE FROM saved_network_records
      WHERE record_id IN (
        SELECT r.record_id
        FROM saved_network_records r
        ${whereSql}
      )
    `);

    return withSqliteTransaction(database, () => {
      if (input.capture === undefined && input.tag === undefined) {
        const cleared = (countAll.get() as { readonly cleared: number }).cleared;
        deleteAllRecords.run();
        return cleared;
      }
      const args = parameters as readonly (string | number | null | Uint8Array)[];
      const cleared = (countFiltered.get(...args) as { readonly cleared: number }).cleared;
      deleteFiltered.run(...args);
      return cleared;
    });
  }

  private async requireDatabase(): Promise<NodeSqliteDatabaseSync> {
    if (this.database) {
      return this.database;
    }
    this.databaseInitialization ??= this.openDatabase();
    try {
      return await this.databaseInitialization;
    } catch (error) {
      this.databaseInitialization = undefined;
      throw error;
    }
  }

  private async openDatabase(): Promise<NodeSqliteDatabaseSync> {
    await this.ensureDatabaseDirectory();

    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      ({ DatabaseSync } = await import(NODE_SQLITE_SPECIFIER));
    } catch (error) {
      throw normalizeSqliteImportError(error);
    }

    const database = new DatabaseSync(this.databasePath);
    try {
      this.configureDatabase(database);
      this.database = database;
      return database;
    } catch (error) {
      closeSqliteDatabase(database);
      throw error;
    }
  }

  private async ensureDatabaseDirectory(): Promise<void> {
    this.directoryInitialization ??= ensureDirectory(path.dirname(this.databasePath)).catch(
      (error) => {
        this.directoryInitialization = undefined;
        throw error;
      },
    );
    await this.directoryInitialization;
  }

  private configureDatabase(database: NodeSqliteDatabaseSync): void {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS saved_network_records (
        record_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        session_ref TEXT NOT NULL,
        page_ref TEXT,
        page_ref_key TEXT NOT NULL,
        frame_ref TEXT,
        document_ref TEXT,
        capture TEXT,
        method TEXT NOT NULL,
        method_lc TEXT NOT NULL,
        url TEXT NOT NULL,
        url_lc TEXT NOT NULL,
        hostname TEXT NOT NULL,
        hostname_lc TEXT NOT NULL,
        path TEXT NOT NULL,
        path_lc TEXT NOT NULL,
        status INTEGER,
        status_text TEXT,
        resource_type TEXT NOT NULL,
        navigation_request INTEGER NOT NULL,
        request_headers_json TEXT NOT NULL,
        response_headers_json TEXT NOT NULL,
        request_body_json TEXT,
        response_body_json TEXT,
        initiator_json TEXT,
        timing_json TEXT,
        transfer_json TEXT,
        source_json TEXT,
        capture_state TEXT NOT NULL,
        request_body_state TEXT NOT NULL,
        response_body_state TEXT NOT NULL,
        request_body_skip_reason TEXT,
        response_body_skip_reason TEXT,
        request_body_error TEXT,
        response_body_error TEXT,
        redirect_from_request_id TEXT,
        redirect_to_request_id TEXT,
        saved_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS saved_network_records_scope_request
        ON saved_network_records (session_ref, page_ref_key, request_id);

      CREATE INDEX IF NOT EXISTS saved_network_records_saved_at
        ON saved_network_records (saved_at DESC);

      CREATE INDEX IF NOT EXISTS saved_network_records_capture
        ON saved_network_records (capture);

      CREATE TABLE IF NOT EXISTS saved_network_tags (
        record_id TEXT NOT NULL REFERENCES saved_network_records(record_id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (record_id, tag)
      );

      CREATE INDEX IF NOT EXISTS saved_network_tags_tag
        ON saved_network_tags (tag);
    `);
    this.ensureColumn(
      database,
      "saved_network_records",
      "capture_state",
      "TEXT NOT NULL DEFAULT 'complete'",
    );
    this.ensureColumn(database, "saved_network_records", "capture", "TEXT");
    this.ensureColumn(
      database,
      "saved_network_records",
      "request_body_state",
      "TEXT NOT NULL DEFAULT 'skipped'",
    );
    this.ensureColumn(
      database,
      "saved_network_records",
      "response_body_state",
      "TEXT NOT NULL DEFAULT 'skipped'",
    );
    this.ensureColumn(database, "saved_network_records", "request_body_skip_reason", "TEXT");
    this.ensureColumn(database, "saved_network_records", "response_body_skip_reason", "TEXT");
    this.ensureColumn(database, "saved_network_records", "request_body_error", "TEXT");
    this.ensureColumn(database, "saved_network_records", "response_body_error", "TEXT");
  }

  private ensureColumn(
    database: NodeSqliteDatabaseSync,
    table: string,
    column: string,
    definition: string,
  ): void {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<{
      readonly name?: string;
    }>;
    if (rows.some((row) => row.name === column)) {
      return;
    }
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function buildSavedNetworkWhere(input: SavedNetworkQueryInput): {
  readonly whereSql: string;
  readonly parameters: readonly unknown[];
} {
  const clauses: string[] = [];
  const parameters: unknown[] = [];

  if (input.pageRef !== undefined) {
    clauses.push("r.page_ref_key = ?");
    parameters.push(input.pageRef);
  }
  if (input.recordId !== undefined) {
    clauses.push("r.record_id = ?");
    parameters.push(input.recordId);
  }
  if (input.requestId !== undefined) {
    clauses.push("r.request_id = ?");
    parameters.push(input.requestId);
  }
  if (input.capture !== undefined) {
    clauses.push("r.capture = ?");
    parameters.push(input.capture);
  }
  if (input.tag !== undefined) {
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM saved_network_tags exact_tag
        WHERE exact_tag.record_id = r.record_id
          AND exact_tag.tag = ?
      )
    `);
    parameters.push(input.tag);
  }
  if (input.url !== undefined) {
    clauses.push("instr(r.url_lc, ?) > 0");
    parameters.push(input.url.toLowerCase());
  }
  if (input.hostname !== undefined) {
    clauses.push("instr(r.hostname_lc, ?) > 0");
    parameters.push(input.hostname.toLowerCase());
  }
  if (input.path !== undefined) {
    clauses.push("instr(r.path_lc, ?) > 0");
    parameters.push(input.path.toLowerCase());
  }
  if (input.method !== undefined) {
    clauses.push("instr(r.method_lc, ?) > 0");
    parameters.push(input.method.toLowerCase());
  }
  if (input.status !== undefined) {
    clauses.push("instr(lower(COALESCE(CAST(r.status AS TEXT), '')), ?) > 0");
    parameters.push(input.status.toLowerCase());
  }
  if (input.resourceType !== undefined) {
    clauses.push("r.resource_type = ?");
    parameters.push(input.resourceType);
  }

  return {
    whereSql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
    parameters,
  };
}

function buildSavedNetworkUpsertSql(bodyWriteMode: SavedNetworkBodyWriteMode): string {
  const bodyUpdateSql =
    bodyWriteMode === "authoritative"
      ? `
        request_body_json = excluded.request_body_json,
        response_body_json = excluded.response_body_json,
        request_body_state = excluded.request_body_state,
        response_body_state = excluded.response_body_state,
        request_body_skip_reason = excluded.request_body_skip_reason,
        response_body_skip_reason = excluded.response_body_skip_reason,
        request_body_error = excluded.request_body_error,
        response_body_error = excluded.response_body_error,
`
      : "";

  return `
      INSERT INTO saved_network_records (
        record_id,
        request_id,
        session_ref,
        page_ref,
        page_ref_key,
        frame_ref,
        document_ref,
        capture,
        method,
        method_lc,
        url,
        url_lc,
        hostname,
        hostname_lc,
        path,
        path_lc,
        status,
        status_text,
        resource_type,
        navigation_request,
        request_headers_json,
        response_headers_json,
        request_body_json,
        response_body_json,
        initiator_json,
        timing_json,
        transfer_json,
        source_json,
        capture_state,
        request_body_state,
        response_body_state,
        request_body_skip_reason,
        response_body_skip_reason,
        request_body_error,
        response_body_error,
        redirect_from_request_id,
        redirect_to_request_id,
        saved_at
      ) VALUES (
        @record_id,
        @request_id,
        @session_ref,
        @page_ref,
        @page_ref_key,
        @frame_ref,
        @document_ref,
        @capture,
        @method,
        @method_lc,
        @url,
        @url_lc,
        @hostname,
        @hostname_lc,
        @path,
        @path_lc,
        @status,
        @status_text,
        @resource_type,
        @navigation_request,
        @request_headers_json,
        @response_headers_json,
        @request_body_json,
        @response_body_json,
        @initiator_json,
        @timing_json,
        @transfer_json,
        @source_json,
        @capture_state,
        @request_body_state,
        @response_body_state,
        @request_body_skip_reason,
        @response_body_skip_reason,
        @request_body_error,
        @response_body_error,
        @redirect_from_request_id,
        @redirect_to_request_id,
        @saved_at
      )
      ON CONFLICT(record_id) DO UPDATE SET
        page_ref = excluded.page_ref,
        page_ref_key = excluded.page_ref_key,
        frame_ref = excluded.frame_ref,
        document_ref = excluded.document_ref,
        capture = excluded.capture,
        method = excluded.method,
        method_lc = excluded.method_lc,
        url = excluded.url,
        url_lc = excluded.url_lc,
        hostname = excluded.hostname,
        hostname_lc = excluded.hostname_lc,
        path = excluded.path,
        path_lc = excluded.path_lc,
        status = excluded.status,
        status_text = excluded.status_text,
        resource_type = excluded.resource_type,
        navigation_request = excluded.navigation_request,
        request_headers_json = excluded.request_headers_json,
        response_headers_json = excluded.response_headers_json,
${bodyUpdateSql}        initiator_json = excluded.initiator_json,
        timing_json = excluded.timing_json,
        transfer_json = excluded.transfer_json,
        source_json = excluded.source_json,
        capture_state = excluded.capture_state,
        redirect_from_request_id = excluded.redirect_from_request_id,
        redirect_to_request_id = excluded.redirect_to_request_id,
        saved_at = MIN(saved_network_records.saved_at, excluded.saved_at)
    `;
}

function inflateSavedNetworkRow(row: SavedNetworkRow, includeBodies: boolean): NetworkQueryRecord {
  const requestBody =
    includeBodies && row.request_body_json !== null ? JSON.parse(row.request_body_json) : undefined;
  const responseBody =
    includeBodies && row.response_body_json !== null
      ? JSON.parse(row.response_body_json)
      : undefined;

  const record = {
    kind: "http",
    requestId: row.request_id as NetworkQueryRecord["record"]["requestId"],
    sessionRef: row.session_ref as NetworkQueryRecord["record"]["sessionRef"],
    method: row.method,
    url: row.url,
    requestHeaders: JSON.parse(row.request_headers_json),
    responseHeaders: JSON.parse(row.response_headers_json),
    resourceType: row.resource_type as NetworkResourceType,
    navigationRequest: row.navigation_request === 1,
    captureState: row.capture_state as NetworkQueryRecord["record"]["captureState"],
    requestBodyState: row.request_body_state as NetworkQueryRecord["record"]["requestBodyState"],
    responseBodyState: row.response_body_state as NetworkQueryRecord["record"]["responseBodyState"],
  } as Mutable<NetworkQueryRecord["record"]>;
  if (row.page_ref !== null) {
    record.pageRef = row.page_ref as NonNullable<NetworkQueryRecord["record"]["pageRef"]>;
  }
  if (row.frame_ref !== null) {
    record.frameRef = row.frame_ref as NonNullable<NetworkQueryRecord["record"]["frameRef"]>;
  }
  if (row.document_ref !== null) {
    record.documentRef = row.document_ref as NonNullable<
      NetworkQueryRecord["record"]["documentRef"]
    >;
  }
  if (row.status !== null) {
    record.status = row.status;
  }
  if (row.status_text !== null) {
    record.statusText = row.status_text;
  }
  if (row.redirect_from_request_id !== null) {
    record.redirectFromRequestId =
      row.redirect_from_request_id as NetworkQueryRecord["record"]["requestId"];
  }
  if (row.redirect_to_request_id !== null) {
    record.redirectToRequestId =
      row.redirect_to_request_id as NetworkQueryRecord["record"]["requestId"];
  }
  if (row.initiator_json !== null) {
    record.initiator = JSON.parse(row.initiator_json);
  }
  if (row.timing_json !== null) {
    record.timing = JSON.parse(row.timing_json);
  }
  if (row.transfer_json !== null) {
    record.transfer = JSON.parse(row.transfer_json);
  }
  if (row.source_json !== null) {
    record.source = JSON.parse(row.source_json);
  }
  if (row.request_body_skip_reason !== null) {
    record.requestBodySkipReason = row.request_body_skip_reason;
  }
  if (row.response_body_skip_reason !== null) {
    record.responseBodySkipReason = row.response_body_skip_reason;
  }
  if (row.request_body_error !== null) {
    record.requestBodyError = row.request_body_error;
  }
  if (row.response_body_error !== null) {
    record.responseBodyError = row.response_body_error;
  }
  if (requestBody !== undefined) {
    record.requestBody = requestBody;
  }
  if (responseBody !== undefined) {
    record.responseBody = responseBody;
  }

  return {
    recordId: row.record_id,
    ...(row.capture === null ? {} : { capture: row.capture }),
    ...(row.tags === null || row.tags.length === 0
      ? {}
      : { tags: row.tags.split(TAG_DELIMITER).filter((tag) => tag.length > 0) }),
    savedAt: row.saved_at,
    record: record as NetworkQueryRecord["record"],
  };
}

function stringifyOptional(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function normalizeSqliteImportError(error: unknown): Error {
  if (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_UNKNOWN_BUILTIN_MODULE" &&
    error.message.includes(NODE_SQLITE_SPECIFIER)
  ) {
    return new Error(SAVED_NETWORK_SQLITE_SUPPORT_ERROR, {
      cause: error,
    });
  }

  return error instanceof Error ? error : new Error(String(error));
}

function closeSqliteDatabase(database: NodeSqliteDatabaseSync): void {
  try {
    database.close();
  } catch {}
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

function withSqliteTransaction<T>(database: NodeSqliteDatabaseSync, task: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = task();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function createSavedNetworkStore(rootPath: string): SavedNetworkStore {
  return new SqliteSavedNetworkStore(rootPath);
}
