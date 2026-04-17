import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AppendObservationEventInput,
  ConfigureObservationSessionInput,
  ObservationArtifact,
  ObservationEvent,
  ObservationSession,
  ObservationSink,
  ObservabilityConfig,
  ObservabilityProfile,
  OpenObservationSessionInput,
  SessionObservationSink,
  WriteObservationArtifactInput,
} from "@opensteer/protocol";

import type { ArtifactManifest, OpensteerArtifactStore } from "./artifacts.js";
import { manifestToExternalBinaryLocation } from "./artifacts.js";
import {
  encodePathSegment,
  ensureDirectory,
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
import { toCanonicalJsonValue } from "./json.js";
import {
  createObservationRedactor,
  normalizeObservationContext,
  type ObservationRedactor,
} from "./observation-utils.js";

export interface ListObservationEventsInput {
  readonly kind?: ObservationEvent["kind"];
  readonly phase?: ObservationEvent["phase"];
  readonly correlationId?: string;
  readonly pageRef?: string;
  readonly afterSequence?: number;
  readonly from?: number;
  readonly to?: number;
  readonly limit?: number;
}

export interface ListObservationArtifactsInput {
  readonly kind?: ObservationArtifact["kind"];
  readonly pageRef?: string;
  readonly limit?: number;
}

export interface FilesystemObservationStore extends ObservationSink {
  readonly sessionsDirectory: string;

  initialize(): Promise<void>;
  getSession(sessionId: string): Promise<ObservationSession | undefined>;
  listEvents(
    sessionId: string,
    input?: ListObservationEventsInput,
  ): Promise<readonly ObservationEvent[]>;
  listArtifacts(
    sessionId: string,
    input?: ListObservationArtifactsInput,
  ): Promise<readonly ObservationArtifact[]>;
  getArtifact(sessionId: string, artifactId: string): Promise<ObservationArtifact | undefined>;
}

interface NormalizedObservabilityConfig extends ObservabilityConfig {
  readonly profile: ObservabilityProfile;
}

export function normalizeObservabilityConfig(
  input: Partial<ObservabilityConfig> | undefined,
): NormalizedObservabilityConfig {
  const profile = input?.profile ?? "diagnostic";
  const labels =
    input?.labels === undefined
      ? undefined
      : Object.entries(input.labels).reduce<Record<string, string>>((accumulator, [key, value]) => {
          const normalizedKey = key.trim();
          const normalizedValue = value.trim();
          if (normalizedKey.length === 0 || normalizedValue.length === 0) {
            return accumulator;
          }
          if (Object.keys(accumulator).length >= 20) {
            return accumulator;
          }
          accumulator[normalizedKey] = normalizedValue;
          return accumulator;
        }, {});
  const redaction =
    input?.redaction === undefined
      ? undefined
      : {
          ...(input.redaction.sensitiveKeys === undefined
            ? {}
            : {
                sensitiveKeys: input.redaction.sensitiveKeys
                  .map((value) => value.trim())
                  .filter((value) => value.length > 0),
              }),
          ...(input.redaction.sensitiveValues === undefined
            ? {}
            : {
                sensitiveValues: input.redaction.sensitiveValues
                  .map((value) => value.trim())
                  .filter((value) => value.length > 0),
              }),
        };

  return {
    profile,
    ...(labels === undefined || Object.keys(labels).length === 0 ? {} : { labels }),
    ...(input?.traceContext === undefined
      ? {}
      : {
          traceContext: {
            ...(input.traceContext.traceparent === undefined
              ? {}
              : { traceparent: input.traceContext.traceparent.trim() }),
            ...(input.traceContext.baggage === undefined
              ? {}
              : { baggage: input.traceContext.baggage.trim() }),
          },
        }),
    ...(redaction === undefined ? {} : { redaction }),
  };
}

function eventFileName(sequence: number): string {
  return `${String(sequence).padStart(12, "0")}.json`;
}

class FilesystemSessionSink implements SessionObservationSink {
  constructor(
    private readonly store: FilesystemObservationStoreImpl,
    readonly sessionId: string,
  ) {}

  configure(input: ConfigureObservationSessionInput): Promise<void> {
    return this.store.configureSession(this.sessionId, input);
  }

  append(input: AppendObservationEventInput): Promise<ObservationEvent> {
    return this.store.appendEvent(this.sessionId, input);
  }

  appendBatch(input: readonly AppendObservationEventInput[]): Promise<readonly ObservationEvent[]> {
    return this.store.appendEvents(this.sessionId, input);
  }

  writeArtifact(input: WriteObservationArtifactInput): Promise<ObservationArtifact> {
    return this.store.writeArtifact(this.sessionId, input);
  }

  async flush(): Promise<void> {}

  close(reason?: string): Promise<void> {
    return this.store.closeSession(this.sessionId, reason);
  }
}

class FilesystemObservationStoreImpl implements FilesystemObservationStore {
  readonly sessionsDirectory: string;
  private readonly redactors = new Map<string, ObservationRedactor>();

  constructor(
    private readonly rootPath: string,
    private readonly artifacts: OpensteerArtifactStore,
  ) {
    this.sessionsDirectory = path.join(this.rootPath, "observations", "sessions");
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.sessionsDirectory);
  }

  async openSession(input: OpenObservationSessionInput): Promise<SessionObservationSink> {
    const sessionId = normalizeNonEmptyString("sessionId", input.sessionId);
    const openedAt = normalizeTimestamp("openedAt", input.openedAt ?? Date.now());
    const config = normalizeObservabilityConfig(input.config);
    await this.applySessionConfiguration(sessionId, config, openedAt);

    return new FilesystemSessionSink(this, sessionId);
  }

  async configureSession(
    sessionId: string,
    input: ConfigureObservationSessionInput,
  ): Promise<void> {
    const updatedAt = normalizeTimestamp("updatedAt", input.updatedAt ?? Date.now());
    const config = normalizeObservabilityConfig(input.config);
    await this.applySessionConfiguration(sessionId, config, updatedAt);
  }

  async getSession(sessionId: string): Promise<ObservationSession | undefined> {
    const manifestPath = this.sessionManifestPath(sessionId);
    if (!(await pathExists(manifestPath))) {
      return undefined;
    }

    return readJsonFile<ObservationSession>(manifestPath);
  }

  async appendEvent(
    sessionId: string,
    input: AppendObservationEventInput,
  ): Promise<ObservationEvent> {
    const [event] = await this.appendEvents(sessionId, [input]);
    if (event === undefined) {
      throw new Error(`failed to append observation event for session ${sessionId}`);
    }
    return event;
  }

  async appendEvents(
    sessionId: string,
    input: readonly AppendObservationEventInput[],
  ): Promise<readonly ObservationEvent[]> {
    if (input.length === 0) {
      return [];
    }

    return withFilesystemLock(this.sessionLockPath(sessionId), async () => {
      const session = await this.reconcileSessionManifest(sessionId);
      if (session === undefined) {
        throw new Error(`observation session ${sessionId} was not found`);
      }
      const redactor = this.redactors.get(sessionId) ?? createObservationRedactor(undefined);

      const events: ObservationEvent[] = [];
      let sequence = session.currentSequence;
      let updatedAt = session.updatedAt;

      for (const raw of input) {
        sequence += 1;
        const createdAt = normalizeTimestamp("createdAt", raw.createdAt);
        const context = normalizeObservationContext(raw.context);
        const redactedData =
          raw.data === undefined ? undefined : redactor.redactJson(toCanonicalJsonValue(raw.data));
        const redactedError = redactor.redactError(raw.error);
        const event: ObservationEvent = {
          eventId: normalizeNonEmptyString(
            "eventId",
            raw.eventId ?? `observation:${sessionId}:${String(sequence).padStart(12, "0")}`,
          ),
          sessionId,
          sequence,
          kind: raw.kind,
          phase: raw.phase,
          createdAt,
          correlationId: normalizeNonEmptyString("correlationId", raw.correlationId),
          ...(raw.spanId === undefined
            ? {}
            : { spanId: normalizeNonEmptyString("spanId", raw.spanId) }),
          ...(raw.parentSpanId === undefined
            ? {}
            : { parentSpanId: normalizeNonEmptyString("parentSpanId", raw.parentSpanId) }),
          ...(context === undefined ? {} : { context }),
          ...(redactedData === undefined ? {} : { data: redactedData }),
          ...(redactedError === undefined ? {} : { error: redactedError }),
          ...(raw.artifactIds === undefined || raw.artifactIds.length === 0
            ? {}
            : { artifactIds: [...raw.artifactIds] }),
        };

        await writeJsonFileExclusive(
          path.join(this.sessionEventsDirectory(sessionId), eventFileName(sequence)),
          event,
        );
        updatedAt = Math.max(updatedAt, createdAt);
        events.push(event);
      }

      await writeJsonFileAtomic(this.sessionManifestPath(sessionId), {
        ...session,
        currentSequence: sequence,
        eventCount: session.eventCount + events.length,
        updatedAt,
      } satisfies ObservationSession);

      return events;
    });
  }

  async writeArtifact(
    sessionId: string,
    input: WriteObservationArtifactInput,
  ): Promise<ObservationArtifact> {
    return withFilesystemLock(this.sessionLockPath(sessionId), async () => {
      const session = await this.reconcileSessionManifest(sessionId);
      if (session === undefined) {
        throw new Error(`observation session ${sessionId} was not found`);
      }
      const redactor = this.redactors.get(sessionId) ?? createObservationRedactor(undefined);

      const createdAt = normalizeTimestamp("createdAt", input.createdAt);
      const context = normalizeObservationContext(input.context);
      const redactedStorageKey =
        input.storageKey === undefined ? undefined : redactor.redactText(input.storageKey);
      const redactedMetadata =
        input.metadata === undefined
          ? undefined
          : redactor.redactJson(toCanonicalJsonValue(input.metadata));
      const artifact: ObservationArtifact = {
        artifactId: normalizeNonEmptyString("artifactId", input.artifactId),
        sessionId,
        kind: input.kind,
        createdAt,
        ...(context === undefined ? {} : { context }),
        ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
        ...(input.byteLength === undefined ? {} : { byteLength: input.byteLength }),
        ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
        ...(input.opensteerArtifactId === undefined
          ? {}
          : { opensteerArtifactId: input.opensteerArtifactId }),
        ...(redactedStorageKey === undefined ? {} : { storageKey: redactedStorageKey }),
        ...(redactedMetadata === undefined ? {} : { metadata: redactedMetadata }),
      };

      const artifactPath = this.sessionArtifactPath(sessionId, artifact.artifactId);
      if (!(await pathExists(artifactPath))) {
        await writeJsonFileExclusive(artifactPath, artifact);
        await writeJsonFileAtomic(this.sessionManifestPath(sessionId), {
          ...session,
          artifactCount: session.artifactCount + 1,
          updatedAt: Math.max(session.updatedAt, createdAt),
        } satisfies ObservationSession);
      }

      return artifact;
    });
  }

  async listEvents(
    sessionId: string,
    input: ListObservationEventsInput = {},
  ): Promise<readonly ObservationEvent[]> {
    const directoryPath = this.sessionEventsDirectory(sessionId);
    if (!(await pathExists(directoryPath))) {
      return [];
    }

    const files = await listJsonFiles(directoryPath);
    const events = await Promise.all(
      files.map((fileName) => readJsonFile<ObservationEvent>(path.join(directoryPath, fileName))),
    );
    const filtered = events.filter((event) => {
      if (input.kind !== undefined && event.kind !== input.kind) return false;
      if (input.phase !== undefined && event.phase !== input.phase) return false;
      if (input.correlationId !== undefined && event.correlationId !== input.correlationId) {
        return false;
      }
      if (input.pageRef !== undefined && event.context?.pageRef !== input.pageRef) return false;
      if (input.afterSequence !== undefined && event.sequence <= input.afterSequence) return false;
      if (input.from !== undefined && event.createdAt < input.from) return false;
      if (input.to !== undefined && event.createdAt > input.to) return false;
      return true;
    });

    if (input.limit === undefined || filtered.length <= input.limit) {
      return filtered;
    }
    return filtered.slice(-input.limit);
  }

  async listArtifacts(
    sessionId: string,
    input: ListObservationArtifactsInput = {},
  ): Promise<readonly ObservationArtifact[]> {
    const directoryPath = this.sessionArtifactsDirectory(sessionId);
    if (!(await pathExists(directoryPath))) {
      return [];
    }

    const files = await listJsonFiles(directoryPath);
    const artifacts = await Promise.all(
      files.map((fileName) =>
        readJsonFile<ObservationArtifact>(path.join(directoryPath, fileName)),
      ),
    );
    const filtered = artifacts.filter((artifact) => {
      if (input.kind !== undefined && artifact.kind !== input.kind) return false;
      if (input.pageRef !== undefined && artifact.context?.pageRef !== input.pageRef) return false;
      return true;
    });
    if (input.limit === undefined || filtered.length <= input.limit) {
      return filtered;
    }
    return filtered.slice(-input.limit);
  }

  async getArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ObservationArtifact | undefined> {
    const artifactPath = this.sessionArtifactPath(sessionId, artifactId);
    if (!(await pathExists(artifactPath))) {
      return undefined;
    }
    return readJsonFile<ObservationArtifact>(artifactPath);
  }

  async closeSession(sessionId: string, _reason?: string): Promise<void> {
    await withFilesystemLock(this.sessionLockPath(sessionId), async () => {
      const session = await this.reconcileSessionManifest(sessionId);
      if (session === undefined || session.closedAt !== undefined) {
        return;
      }

      const now = Date.now();
      await writeJsonFileAtomic(this.sessionManifestPath(sessionId), {
        ...session,
        updatedAt: Math.max(session.updatedAt, now),
        closedAt: now,
      } satisfies ObservationSession);
    });
    this.redactors.delete(sessionId);
  }

  async writeArtifactFromManifest(
    sessionId: string,
    manifest: ArtifactManifest,
    kind: ObservationArtifact["kind"],
    metadata?: JsonValue,
  ): Promise<ObservationArtifact> {
    return this.writeArtifact(sessionId, {
      artifactId: manifest.artifactId,
      kind,
      createdAt: manifest.createdAt,
      context: manifest.scope,
      mediaType: manifest.mediaType,
      byteLength: manifest.byteLength,
      sha256: manifest.sha256,
      opensteerArtifactId: manifest.artifactId,
      storageKey: manifestToExternalBinaryLocation(this.rootPath, manifest).uri,
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  async ensureArtifactLinked(
    sessionId: string,
    manifest: ArtifactManifest,
  ): Promise<ObservationArtifact> {
    const existing = await this.getArtifact(sessionId, manifest.artifactId);
    if (existing !== undefined) {
      return existing;
    }

    const kind = toObservationArtifactKind(manifest.kind);
    return this.writeArtifactFromManifest(sessionId, manifest, kind);
  }

  async hydrateArtifactManifests(
    artifactIds: readonly string[],
  ): Promise<readonly ArtifactManifest[]> {
    return (
      await Promise.all(
        artifactIds.map(async (artifactId) => this.artifacts.getManifest(artifactId)),
      )
    ).filter((value): value is ArtifactManifest => value !== undefined);
  }

  private sessionDirectory(sessionId: string): string {
    return path.join(this.sessionsDirectory, encodePathSegment(sessionId));
  }

  private sessionManifestPath(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "session.json");
  }

  private sessionEventsDirectory(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "events");
  }

  private sessionArtifactsDirectory(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "artifacts");
  }

  private sessionArtifactPath(sessionId: string, artifactId: string): string {
    return path.join(
      this.sessionArtifactsDirectory(sessionId),
      `${encodePathSegment(artifactId)}.json`,
    );
  }

  private sessionLockPath(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), ".lock");
  }

  private async applySessionConfiguration(
    sessionId: string,
    config: NormalizedObservabilityConfig,
    timestamp: number,
  ): Promise<void> {
    const redactor = createObservationRedactor(config);
    this.redactors.set(sessionId, redactor);
    const redactedLabels = redactor.redactLabels(config.labels);
    const redactedTraceContext = redactor.redactTraceContext(config.traceContext);

    await withFilesystemLock(this.sessionLockPath(sessionId), async () => {
      const existing = await this.reconcileSessionManifest(sessionId);
      if (existing === undefined) {
        await ensureDirectory(this.sessionEventsDirectory(sessionId));
        await ensureDirectory(this.sessionArtifactsDirectory(sessionId));
        const session: ObservationSession = {
          sessionId,
          profile: config.profile,
          ...(redactedLabels === undefined ? {} : { labels: redactedLabels }),
          ...(redactedTraceContext === undefined ? {} : { traceContext: redactedTraceContext }),
          openedAt: timestamp,
          updatedAt: timestamp,
          currentSequence: 0,
          eventCount: 0,
          artifactCount: 0,
        };
        await writeJsonFileExclusive(this.sessionManifestPath(sessionId), session);
        return;
      }

      const patched: ObservationSession = {
        ...existing,
        profile: config.profile,
        ...(redactedLabels === undefined ? {} : { labels: redactedLabels }),
        ...(redactedTraceContext === undefined ? {} : { traceContext: redactedTraceContext }),
        updatedAt: Math.max(existing.updatedAt, timestamp),
      };
      await writeJsonFileAtomic(this.sessionManifestPath(sessionId), patched);
    });
  }

  private async reconcileSessionManifest(
    sessionId: string,
  ): Promise<ObservationSession | undefined> {
    const session = await this.getSession(sessionId);
    if (session === undefined) {
      return undefined;
    }

    const [hasEventDirectory, hasArtifactDirectory] = await Promise.all([
      pathExists(this.sessionEventsDirectory(sessionId)),
      pathExists(this.sessionArtifactsDirectory(sessionId)),
    ]);
    const [eventFiles, artifactFiles] = await Promise.all([
      hasEventDirectory
        ? listJsonFiles(this.sessionEventsDirectory(sessionId))
        : Promise.resolve([]),
      hasArtifactDirectory
        ? listJsonFiles(this.sessionArtifactsDirectory(sessionId))
        : Promise.resolve([]),
    ]);

    const currentSequence = eventFiles.reduce((maxSequence, fileName) => {
      const parsed = Number.parseInt(fileName.replace(/\.json$/u, ""), 10);
      return Number.isFinite(parsed) ? Math.max(maxSequence, parsed) : maxSequence;
    }, 0);
    const eventCount = eventFiles.length;
    const artifactCount = artifactFiles.length;

    if (
      session.currentSequence === currentSequence &&
      session.eventCount === eventCount &&
      session.artifactCount === artifactCount
    ) {
      return session;
    }

    const [events, artifacts] = await Promise.all([
      Promise.all(
        eventFiles.map((fileName) =>
          readJsonFile<ObservationEvent>(
            path.join(this.sessionEventsDirectory(sessionId), fileName),
          ),
        ),
      ),
      Promise.all(
        artifactFiles.map((fileName) =>
          readJsonFile<ObservationArtifact>(
            path.join(this.sessionArtifactsDirectory(sessionId), fileName),
          ),
        ),
      ),
    ]);

    const updatedAt = Math.max(
      session.openedAt,
      session.closedAt ?? 0,
      ...events.map((event) => event.createdAt),
      ...artifacts.map((artifact) => artifact.createdAt),
    );
    const reconciled: ObservationSession = {
      ...session,
      currentSequence,
      eventCount,
      artifactCount,
      updatedAt,
    };
    await writeJsonFileAtomic(this.sessionManifestPath(sessionId), reconciled);
    return reconciled;
  }
}

function toObservationArtifactKind(kind: ArtifactManifest["kind"]): ObservationArtifact["kind"] {
  switch (kind) {
    case "screenshot":
      return "screenshot";
    case "dom-snapshot":
      return "dom-snapshot";
    case "html-snapshot":
      return "html-snapshot";
    default:
      return "other";
  }
}

export function createObservationStore(
  rootPath: string,
  artifacts: OpensteerArtifactStore,
): FilesystemObservationStore {
  return new FilesystemObservationStoreImpl(rootPath, artifacts);
}
