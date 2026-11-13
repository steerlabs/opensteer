import { DeploymentIdSchema } from "@opensteer/core";
import { createHttpHostApiClient, type WebSocketClient } from "@opensteer/client/host";
import {
  TeamBinaryUploadMetadataSchema,
  TeamBootstrapSchema,
  TeamFileSchema,
  teamApiVersion,
  teamApiVersionHeader,
  teamPreviewMaxBytes,
  teamUploadMaxBytes,
} from "@opensteer/protocol";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import type {
  TeamCacheScope,
  TeamFileUpload,
  TeamPersistence,
  TeamSavedState,
  TeamSessionOptions,
  TeamRuntimeOwner,
} from "@opensteer/client/team";
import { teamCacheKey, TeamSavedStateSchema } from "@opensteer/client/team";
import type { z } from "zod";
import {
  createDesktopHostFetch,
  createDesktopHostWebSocketFactory,
} from "../desktop/desktop-host-transport.js";

type TeamFile = z.infer<typeof TeamFileSchema>;
type Notify = TeamSessionOptions["notify"];

const savedPrefix = "opensteer:team-saved:v1:";

/**
 * Unsent team drafts and unconfirmed sends, on this device, per team and
 * person. They hold only what the person typed, never a credential.
 */
export const localTeamPersistence: TeamPersistence = {
  async load(scope) {
    try {
      const stored = localStorage.getItem(savedPrefix + teamCacheKey(scope));
      if (stored === null) return null;
      const parsed = TeamSavedStateSchema.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  async save(scope, state: TeamSavedState) {
    localStorage.setItem(savedPrefix + teamCacheKey(scope), JSON.stringify(state));
  },
  async remove(scope) {
    try {
      localStorage.removeItem(savedPrefix + teamCacheKey(scope));
    } catch {
      // Nothing to remove.
    }
  },
};

const versionHeaders = { [teamApiVersionHeader]: String(teamApiVersion) };

async function readBlob(response: Response, maximum: number, type: string): Promise<Blob> {
  if (!response.ok) throw new Error("The team file is no longer available.");
  const blob = await response.blob();
  if (blob.size > maximum) throw new Error("Team file exceeds its byte bound.");
  return new Blob([blob], { type });
}

function fileType(file: TeamFile, part: "preview" | "original"): string {
  return part === "preview" ? file.preview!.mediaType : "application/octet-stream";
}

/** The team's own web app: same-origin requests and its session cookie. */
export function browserTeamSession(input: {
  readonly scope: TeamCacheScope;
  /** What the app already read to learn who is signed in: the first load reuses it. */
  readonly bootstrap?: z.infer<typeof TeamBootstrapSchema>;
  readonly notify?: Notify;
}): TeamSessionOptions {
  const origin = window.location.origin;
  const http = createHttpHostApiClient({
    baseUrl: new URL(origin),
    fetch: globalThis.fetch.bind(globalThis),
    kind: "team",
    onAuthenticationRequired: () => undefined,
  });
  let first = input.bootstrap ?? null;
  return {
    scope: input.scope,
    persistence: localTeamPersistence,
    // One round trip before the first screen, not two, on a slow link.
    rpc: first
      ? new Proxy(http, {
          get: (target, property) => {
            if (property !== "team.bootstrap.get" || !first) return Reflect.get(target, property);
            const data = first;
            first = null;
            return async () => ({ data, ok: true });
          },
        })
      : http,
    // A browser can't set headers on the upgrade, so the version rides in the address.
    connect: () =>
      new WebSocket(
        `${origin.replace(/^http/u, "ws")}/v1/realtime?opensteer_api_version=${teamApiVersion}`,
      ),
    readFile: async (file, part, signal) => {
      const metadata = TeamFileSchema.parse(file);
      return readBlob(
        await fetch(`/v1/team/files/${metadata.id}/${part}`, {
          credentials: "include",
          headers: versionHeaders,
          ...(signal ? { signal } : {}),
        }),
        part === "preview" ? teamPreviewMaxBytes : teamUploadMaxBytes,
        fileType(metadata, part),
      );
    },
    uploadFile: async (upload: TeamFileUpload) => {
      const metadata = TeamBinaryUploadMetadataSchema.parse(upload.metadata);
      const response = await fetch(`/v1/team/files/upload/${upload.channelId}`, {
        body: new Blob([upload.original, ...(upload.preview ? [upload.preview] : [])]),
        credentials: "include",
        headers: {
          ...versionHeaders,
          "content-type": "application/octet-stream",
          "x-opensteer-team-upload": JSON.stringify(metadata),
        },
        method: "POST",
        ...(upload.signal ? { signal: upload.signal } : {}),
      });
      if (!response.ok) throw new Error("The team file could not be uploaded.");
      return TeamFileSchema.parse(await response.json());
    },
    ...(input.notify ? { notify: input.notify } : {}),
  };
}

/**
 * A joined team on the desktop: every request, socket and file crosses the
 * bridge pinned to the team's own Host, which holds its credential.
 */
export function desktopTeamSession(input: {
  readonly owner?: TeamRuntimeOwner;
  readonly bridge: OpensteerDesktopBridge;
  readonly origin: string;
  readonly scope: TeamCacheScope;
  readonly notify?: Notify;
}): TeamSessionOptions {
  const deploymentId = DeploymentIdSchema.parse(input.scope.teamDeploymentId);
  const owner = input.owner;
  const socket = createDesktopHostWebSocketFactory(input.bridge, input.origin, deploymentId);
  const transfer = async (
    path: string,
    method: "GET" | "POST",
    headers: { contentType?: "application/octet-stream"; teamUpload?: string },
    body: Blob | null,
    signal?: AbortSignal,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType: string | null }> => {
    owner?.assertCurrent();
    const opened = await input.bridge.hostBinaryOpen({
      expectedDeploymentId: deploymentId,
      headers: { apiVersion: String(teamApiVersion), ...headers },
      method,
      path,
      timeoutMs: 120_000,
    });
    if (!opened.ok) throw new Error("The team file could not be reached.");
    const transferId = opened.data.transferId;
    signal = owner ? AbortSignal.any([owner.signal, ...(signal ? [signal] : [])]) : signal;
    const abort = () => void input.bridge.hostBinaryClose({ transferId }).catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      if (body) {
        const bytes = new Uint8Array(await body.arrayBuffer());
        for (let offset = 0; offset < bytes.byteLength; offset += 256 * 1024) {
          const written = await input.bridge.hostBinaryWrite({
            bytes: bytes.subarray(offset, offset + 256 * 1024),
            transferId,
          });
          signal?.throwIfAborted();
          if (!written.ok) throw new Error("The team file could not be uploaded.");
        }
        const finished = await input.bridge.hostBinaryFinish({ transferId });
        signal?.throwIfAborted();
        if (!finished.ok || finished.data.status >= 400)
          throw new Error("The team file could not be uploaded.");
        return {
          bytes: new TextEncoder().encode(finished.data.body),
          contentType: finished.data.headers.contentType,
        };
      }
      const parts: Uint8Array[] = [];
      let contentType: string | null = null;
      for (;;) {
        const read = await input.bridge.hostBinaryRead({ transferId });
        signal?.throwIfAborted();
        if (!read.ok || read.data.status >= 400)
          throw new Error("The team file is no longer available.");
        contentType ??= read.data.contentType;
        if (read.data.bytes.byteLength > 0) parts.push(read.data.bytes);
        if (read.data.done) break;
      }
      const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      return { bytes, contentType };
    } finally {
      signal?.removeEventListener("abort", abort);
      await input.bridge.hostBinaryClose({ transferId }).catch(() => undefined);
    }
  };
  return {
    scope: input.scope,
    ...(owner ? { owner } : {}),
    persistence: owner ? ownedLocalTeamPersistence(owner) : localTeamPersistence,
    rpc: createHttpHostApiClient({
      baseUrl: new URL(input.origin),
      bufferedResponses: true,
      fetch: async (url, init) => {
        owner?.assertCurrent();
        const response = await createDesktopHostFetch(
          input.bridge,
          input.origin,
          deploymentId,
        )(url, { ...init, ...(owner ? { signal: owner.signal } : {}) });
        owner?.assertCurrent();
        return response;
      },
      assertResponseCurrent: () => owner?.assertCurrent(),
      kind: "team",
      onAuthenticationRequired: () => undefined,
    }),
    connect: (): WebSocketClient => socket(`${input.origin.replace(/^http/u, "ws")}/v1/realtime`),
    readFile: async (file, part, signal) => {
      const metadata = TeamFileSchema.parse(file);
      const { bytes } = await transfer(
        `/v1/team/files/${metadata.id}/${part}`,
        "GET",
        {},
        null,
        signal,
      );
      if (bytes.byteLength > (part === "preview" ? teamPreviewMaxBytes : teamUploadMaxBytes))
        throw new Error("Team file exceeds its byte bound.");
      return new Blob([Uint8Array.from(bytes)], { type: fileType(metadata, part) });
    },
    uploadFile: async (upload) => {
      const metadata = TeamBinaryUploadMetadataSchema.parse(upload.metadata);
      const { bytes } = await transfer(
        `/v1/team/files/upload/${upload.channelId}`,
        "POST",
        { contentType: "application/octet-stream", teamUpload: JSON.stringify(metadata) },
        new Blob([upload.original, ...(upload.preview ? [upload.preview] : [])]),
        upload.signal,
      );
      return TeamFileSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    },
    ...(input.notify ? { notify: input.notify } : {}),
  };
}

function ownedLocalTeamPersistence(owner: TeamRuntimeOwner): TeamPersistence {
  const scoped = (scope: TeamCacheScope) => ({ ...scope, userId: scope.userId });
  const key = (scope: TeamCacheScope) =>
    savedPrefix + owner.partition + ":" + teamCacheKey(scoped(scope));
  return {
    async load(scope) {
      owner.assertCurrent();
      const stored = localStorage.getItem(key(scope));
      return stored ? TeamSavedStateSchema.parse(JSON.parse(stored)) : null;
    },
    async save(scope, state) {
      owner.assertCurrent();
      localStorage.setItem(key(scope), JSON.stringify(state));
    },
    async remove(scope) {
      localStorage.removeItem(key(scope));
    },
  };
}
