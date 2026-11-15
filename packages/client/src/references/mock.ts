import { OpensteerError, ThreadIdSchema, parseReferenceHref } from "@opensteer/core";
import {
  ReferenceResolveInputSchema,
  ReferenceResolveResultSchema,
  TranscriptAssetUrlsSchema,
  TranscriptFileOpenSchema,
  TranscriptFileContentSchema,
} from "@opensteer/protocol";
import type { HostSnapshot } from "../host/client.js";
import type { ReferenceReadPorts } from "./contracts.js";
import { localReference } from "./local.js";

export const mockFailedReferenceId = ThreadIdSchema.parse(
  "thr_00000000-0000-4000-8000-000000000902",
);
export const mockTranscriptFilePath = "/mock/inline-references/report.txt";
const report = "Inline references\nThis file belongs to the mock Host.\n";

export function mockReferenceReadPorts(getSnapshot: () => HostSnapshot): ReferenceReadPorts {
  return {
    resolveReferences: async (input) => {
      const { ids } = ReferenceResolveInputSchema.parse(input);
      if (ids.includes(mockFailedReferenceId))
        throw new OpensteerError({
          code: "timeout",
          message: "The mock Host is temporarily offline.",
          retryable: true,
        });
      const snapshot = getSnapshot();
      return ReferenceResolveResultSchema.parse({
        results: [...new Set(ids)].map((id) => {
          const ref = parseReferenceHref(`opensteer:${id}`)!;
          return localReference(snapshot, ref) ?? { status: "unavailable", id };
        }),
      });
    },
    assetUrls: async ({ assets }) =>
      TranscriptAssetUrlsSchema.parse({
        assets: assets.map(() => ({ status: "unavailable", reason: "missing" })),
      }),
    openFile: async ({ source }) =>
      TranscriptFileOpenSchema.parse(
        source.kind === "path" && source.path === mockTranscriptFilePath
          ? {
              status: "ok",
              resource: { kind: "home", key: "mock-report", revision: "1" },
              name: "report.txt",
              sizeBytes: new TextEncoder().encode(report).byteLength,
              mediaType: "text/plain",
              preview: { kind: "text", text: report, truncated: false },
            }
          : { status: "unavailable" },
      ),
    readFile: async ({ resource }) => {
      if (resource.kind !== "home" || resource.key !== "mock-report" || resource.revision !== "1")
        throw new OpensteerError({ code: "not_found", message: "File unavailable" });
      const bytes = new TextEncoder().encode(report);
      return TranscriptFileContentSchema.parse({
        bytes,
        metadata: {
          contentType: "text/plain",
          etag: "1",
          modifiedAt: null,
          sizeBytes: bytes.byteLength,
          truncated: false,
        },
      });
    },
  };
}
