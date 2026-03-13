import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ArtifactReference,
  OpensteerError,
  OpensteerEvent,
  TraceBundle,
  TraceContext,
  TraceOutcome,
  TraceRecord,
} from "@opensteer/protocol";
import {
  createDocumentEpoch,
  createDocumentRef,
  createFrameRef,
  createPageRef,
  createSessionRef,
} from "@opensteer/protocol";

import type { OpensteerArtifactStore, ProtocolArtifactDelivery } from "./artifacts.js";
import {
  ensureDirectory,
  isAlreadyExistsError,
  listJsonFiles,
  normalizeNonEmptyString,
  normalizeTimestamp,
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
  writeJsonFileExclusive,
  withFilesystemLock,
} from "./internal/filesystem.js";
import type { JsonValue } from "./json.js";

export interface TraceRunManifest {
  readonly runId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly entryCount: number;
}

export interface CreateTraceRunInput {
  readonly runId?: string;
  readonly createdAt?: number;
}

export interface AppendTraceEntryInput<TData extends JsonValue = JsonValue> {
  readonly traceId?: string;
  readonly stepId?: string;
  readonly operation: string;
  readonly outcome: TraceOutcome;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly context?: TraceContext;
  readonly events?: readonly OpensteerEvent[];
  readonly artifacts?: readonly ArtifactReference[];
  readonly data?: TData;
  readonly error?: OpensteerError;
}

export interface TraceEntryRecord<TData extends JsonValue = JsonValue> {
  readonly runId: string;
  readonly sequence: number;
  readonly traceId: string;
  readonly stepId: string;
  readonly operation: string;
  readonly outcome: TraceOutcome;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly context: TraceContext;
  readonly events: readonly OpensteerEvent[];
  readonly artifacts?: readonly ArtifactReference[];
  readonly data?: TData;
  readonly error?: OpensteerError;
}

export interface OpensteerTraceStore {
  readonly runsDirectory: string;

  createRun(input?: CreateTraceRunInput): Promise<TraceRunManifest>;
  getRun(runId: string): Promise<TraceRunManifest | undefined>;
  append<TData extends JsonValue>(
    runId: string,
    input: AppendTraceEntryInput<TData>,
  ): Promise<TraceEntryRecord<TData>>;
  listEntries(runId: string): Promise<readonly TraceEntryRecord[]>;
  getEntry(runId: string, traceId: string): Promise<TraceEntryRecord | undefined>;
  toProtocolTraceRecord<TData extends JsonValue>(
    entry: TraceEntryRecord<TData>,
  ): TraceRecord<TData>;
  readProtocolTraceBundle(
    runId: string,
    traceId: string,
    options?: {
      readonly artifactDelivery?: ProtocolArtifactDelivery;
    },
  ): Promise<TraceBundle | undefined>;
}

function normalizeContext(context: TraceContext | undefined): TraceContext {
  return {
    ...(context?.sessionRef === undefined
      ? {}
      : { sessionRef: createSessionRef(context.sessionRef) }),
    ...(context?.pageRef === undefined ? {} : { pageRef: createPageRef(context.pageRef) }),
    ...(context?.frameRef === undefined ? {} : { frameRef: createFrameRef(context.frameRef) }),
    ...(context?.documentRef === undefined
      ? {}
      : { documentRef: createDocumentRef(context.documentRef) }),
    ...(context?.documentEpoch === undefined
      ? {}
      : { documentEpoch: createDocumentEpoch(context.documentEpoch) }),
  };
}

function sequenceFileName(sequence: number): string {
  return `${String(sequence).padStart(12, "0")}.json`;
}

export class FilesystemTraceStore implements OpensteerTraceStore {
  readonly runsDirectory: string;

  constructor(
    private readonly rootPath: string,
    private readonly artifacts: OpensteerArtifactStore,
  ) {
    this.runsDirectory = path.join(this.rootPath, "traces", "runs");
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.runsDirectory);
  }

  async createRun(input: CreateTraceRunInput = {}): Promise<TraceRunManifest> {
    const runId = normalizeNonEmptyString("runId", input.runId ?? `run:${randomUUID()}`);
    const manifestPath = this.runManifestPath(runId);
    const createdAt = normalizeTimestamp("createdAt", input.createdAt ?? Date.now());
    const manifest: TraceRunManifest = {
      runId,
      createdAt,
      updatedAt: createdAt,
      entryCount: 0,
    };

    await ensureDirectory(this.runEntriesDirectory(runId));
    try {
      await writeJsonFileExclusive(manifestPath, manifest);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error(`trace run ${runId} already exists`);
      }

      throw error;
    }

    return manifest;
  }

  async getRun(runId: string): Promise<TraceRunManifest | undefined> {
    const manifestPath = this.runManifestPath(runId);
    if (!(await pathExists(manifestPath))) {
      return undefined;
    }

    return readJsonFile<TraceRunManifest>(manifestPath);
  }

  async append<TData extends JsonValue>(
    runId: string,
    input: AppendTraceEntryInput<TData>,
  ): Promise<TraceEntryRecord<TData>> {
    const startedAt = normalizeTimestamp("startedAt", input.startedAt);
    const completedAt = normalizeTimestamp("completedAt", input.completedAt);
    if (completedAt < startedAt) {
      throw new RangeError("completedAt must be greater than or equal to startedAt");
    }

    if (input.outcome === "error" && input.error === undefined) {
      throw new TypeError("error traces must include an error payload");
    }
    if (input.outcome === "ok" && input.error !== undefined) {
      throw new TypeError("successful traces must not include an error payload");
    }

    return withFilesystemLock(this.runWriteLockPath(runId), async () => {
      const manifest = await this.getRun(runId);
      if (manifest === undefined) {
        throw new Error(`trace run ${runId} was not found`);
      }

      const sequence = manifest.entryCount + 1;
      const traceId = normalizeNonEmptyString(
        "traceId",
        input.traceId ?? `trace:${runId}:${String(sequence).padStart(12, "0")}`,
      );
      const stepId = normalizeNonEmptyString(
        "stepId",
        input.stepId ?? `step:${runId}:${String(sequence).padStart(12, "0")}`,
      );

      const entry: TraceEntryRecord<TData> = {
        runId,
        sequence,
        traceId,
        stepId,
        operation: normalizeNonEmptyString("operation", input.operation),
        outcome: input.outcome,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        context: normalizeContext(input.context),
        events: [...(input.events ?? [])],
        ...(input.artifacts === undefined || input.artifacts.length === 0
          ? {}
          : { artifacts: [...input.artifacts] }),
        ...(input.data === undefined ? {} : { data: input.data }),
        ...(input.error === undefined ? {} : { error: input.error }),
      };

      await writeJsonFileExclusive(
        path.join(this.runEntriesDirectory(runId), sequenceFileName(sequence)),
        entry,
      );
      await writeJsonFileAtomic(this.runManifestPath(runId), {
        ...manifest,
        updatedAt: Math.max(manifest.updatedAt, completedAt),
        entryCount: sequence,
      } satisfies TraceRunManifest);

      return entry;
    });
  }

  async listEntries(runId: string): Promise<readonly TraceEntryRecord[]> {
    const entriesDirectory = this.runEntriesDirectory(runId);
    if (!(await pathExists(entriesDirectory))) {
      return [];
    }

    const files = await listJsonFiles(entriesDirectory);
    return Promise.all(
      files.map((fileName) =>
        readJsonFile<TraceEntryRecord>(path.join(entriesDirectory, fileName)),
      ),
    );
  }

  async getEntry(runId: string, traceId: string): Promise<TraceEntryRecord | undefined> {
    return (await this.listEntries(runId)).find((entry) => entry.traceId === traceId);
  }

  toProtocolTraceRecord<TData extends JsonValue>(
    entry: TraceEntryRecord<TData>,
  ): TraceRecord<TData> {
    return {
      traceId: entry.traceId,
      stepId: entry.stepId,
      operation: entry.operation,
      outcome: entry.outcome,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      durationMs: entry.durationMs,
      context: entry.context,
      events: entry.events,
      ...(entry.artifacts === undefined ? {} : { artifacts: entry.artifacts }),
      ...(entry.data === undefined ? {} : { data: entry.data }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    };
  }

  async readProtocolTraceBundle(
    runId: string,
    traceId: string,
    options: {
      readonly artifactDelivery?: ProtocolArtifactDelivery;
    } = {},
  ): Promise<TraceBundle | undefined> {
    const entry = await this.getEntry(runId, traceId);
    if (entry === undefined) {
      return undefined;
    }

    const trace = this.toProtocolTraceRecord(entry);
    if (entry.artifacts === undefined || entry.artifacts.length === 0) {
      return { trace };
    }

    const artifacts = [];
    for (const reference of entry.artifacts) {
      const artifact = await this.artifacts.toProtocolArtifact(
        reference.artifactId,
        options.artifactDelivery === undefined ? {} : { delivery: options.artifactDelivery },
      );
      if (artifact === undefined) {
        throw new Error(`trace ${traceId} references missing artifact ${reference.artifactId}`);
      }

      artifacts.push(artifact);
    }

    return { trace, artifacts };
  }

  private runDirectory(runId: string): string {
    return path.join(this.runsDirectory, encodeURIComponent(runId));
  }

  private runEntriesDirectory(runId: string): string {
    return path.join(this.runDirectory(runId), "entries");
  }

  private runManifestPath(runId: string): string {
    return path.join(this.runDirectory(runId), "manifest.json");
  }

  private runWriteLockPath(runId: string): string {
    return path.join(this.runDirectory(runId), ".append.lock");
  }
}

export function createTraceStore(
  rootPath: string,
  artifacts: OpensteerArtifactStore,
): FilesystemTraceStore {
  return new FilesystemTraceStore(rootPath, artifacts);
}
