import type { BrowserCoreEngine, PageRef, SessionRef } from "@opensteer/browser-core";
import type {
  NetworkResourceType,
  OpensteerRequestCaptureScope,
  OpensteerRequestCaptureStartInput,
  OpensteerRequestCaptureStartOutput,
  OpensteerRequestCaptureStopOutput,
} from "@opensteer/protocol";

import type { ArtifactManifest, OpensteerArtifactStore } from "../../artifacts.js";
import { toProtocolNetworkRecord } from "../shared.js";

interface ActiveRequestCapture {
  readonly scope: OpensteerRequestCaptureScope;
  readonly startedAt: number;
  readonly baselineCount: number;
  readonly baselineRequestIds: ReadonlySet<string>;
  readonly sessionRef: SessionRef;
  readonly pageRef?: PageRef;
  readonly resourceTypes?: ReadonlySet<NetworkResourceType>;
}

export interface CompletedRequestCapture {
  readonly artifactManifest: ArtifactManifest;
  readonly output: OpensteerRequestCaptureStopOutput;
}

export class OpensteerRequestCaptureRuntime {
  private activeCapture: ActiveRequestCapture | undefined;

  async start(input: {
    readonly engine: BrowserCoreEngine;
    readonly artifacts: OpensteerArtifactStore;
    readonly sessionRef: SessionRef;
    readonly pageRef: PageRef;
    readonly request?: OpensteerRequestCaptureStartInput;
  }): Promise<OpensteerRequestCaptureStartOutput> {
    void input.artifacts;

    if (this.activeCapture) {
      throw new Error("a request capture is already active for this runtime");
    }

    const scope = input.request?.scope ?? "page";
    const resourceTypes = normalizeResourceTypes(input.request?.resourceTypes);
    const baseline = await input.engine.getNetworkRecords({
      sessionRef: input.sessionRef,
      ...(scope === "page" ? { pageRef: input.pageRef } : {}),
    });
    const filteredBaseline = filterByResourceTypes(baseline, resourceTypes);
    const baselineRequestIds = new Set(filteredBaseline.map((record) => record.requestId));
    const startedAt = Date.now();

    this.activeCapture = {
      scope,
      startedAt,
      baselineCount: filteredBaseline.length,
      baselineRequestIds,
      sessionRef: input.sessionRef,
      ...(scope === "page" ? { pageRef: input.pageRef } : {}),
      ...(resourceTypes === undefined ? {} : { resourceTypes }),
    };

    return {
      scope,
      startedAt,
      baselineCount: filteredBaseline.length,
      ...(resourceTypes === undefined ? {} : { resourceTypes: [...resourceTypes] }),
    };
  }

  async stop(input: {
    readonly engine: BrowserCoreEngine;
    readonly artifacts: OpensteerArtifactStore;
  }): Promise<CompletedRequestCapture> {
    const activeCapture = this.activeCapture;
    if (!activeCapture) {
      throw new Error("no active request capture is running");
    }

    this.activeCapture = undefined;

    const completedAt = Date.now();
    const records = await input.engine.getNetworkRecords({
      sessionRef: activeCapture.sessionRef,
      ...(activeCapture.scope === "page" && activeCapture.pageRef !== undefined
        ? { pageRef: activeCapture.pageRef }
        : {}),
      includeBodies: true,
    });
    const capturedRecords = filterByResourceTypes(records, activeCapture.resourceTypes).filter(
      (record) => !activeCapture.baselineRequestIds.has(record.requestId),
    );
    const redactedRecords = capturedRecords.map((record) =>
      toProtocolNetworkRecord(record, {
        redactSecretHeaders: true,
      }),
    );

    const artifactManifest = await input.artifacts.writeStructured({
      kind: "network-records",
      scope: {
        sessionRef: activeCapture.sessionRef,
        ...(activeCapture.scope === "page" && activeCapture.pageRef !== undefined
          ? { pageRef: activeCapture.pageRef }
          : {}),
      },
      data: redactedRecords,
    });

    return {
      artifactManifest,
      output: {
        scope: activeCapture.scope,
        startedAt: activeCapture.startedAt,
        completedAt,
        baselineCount: activeCapture.baselineCount,
        recordCount: redactedRecords.length,
        artifactId: artifactManifest.artifactId,
        records: redactedRecords,
      },
    };
  }

  clear(): void {
    this.activeCapture = undefined;
  }
}

function normalizeResourceTypes(
  resourceTypes: readonly NetworkResourceType[] | undefined,
): ReadonlySet<NetworkResourceType> | undefined {
  if (resourceTypes === undefined || resourceTypes.length === 0) {
    return undefined;
  }

  return new Set(resourceTypes);
}

function filterByResourceTypes<T extends { readonly resourceType: NetworkResourceType }>(
  records: readonly T[],
  resourceTypes: ReadonlySet<NetworkResourceType> | undefined,
): readonly T[] {
  if (resourceTypes === undefined) {
    return records;
  }

  return records.filter((record) => resourceTypes.has(record.resourceType));
}
