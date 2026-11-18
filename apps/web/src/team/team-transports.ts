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
import {
  teamCacheKey,
  TeamSavedStateSchema,
  teamUploadReplyMaxBytes,
} from "@opensteer/client/team";
import type { z } from "zod";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
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

function fileType(file: TeamFile, part: "preview" | "original"): string {
  return part === "preview" ? file.preview!.mediaType : "application/octet-stream";
}

function ownedSignal(owner: TeamRuntimeOwner | undefined) {
  return (signal?: AbortSignal) =>
    owner ? AbortSignal.any([owner.signal, ...(signal ? [signal] : [])]) : signal;
}

/** What a refused team file transfer tells the person: too large, too busy, or gone. */
function teamFileRefusal(response: Response, otherwise: string): Error {
  if (response.status === 413) return new Error("Files can be up to 100 MB.");
  if (response.status === 429)
    return new Error("Too many files are moving at once. Try again in a moment.");
  return new Error(otherwise);
}

/** Team file bytes over one fetch: the browser's own, or desktop main's route to the team. */
function teamFiles(
  fetch: typeof globalThis.fetch,
  origin: string,
  owner?: TeamRuntimeOwner,
): Pick<TeamSessionOptions, "readFile" | "uploadFile"> {
  const owned = ownedSignal(owner);
  return {
    readFile: async (file, part, signal) => {
      const metadata = TeamFileSchema.parse(file);
      owner?.assertCurrent();
      const read = owned(signal);
      const response = await fetch(new URL(`/v1/team/files/${metadata.id}/${part}`, origin), {
        credentials: "include",
        headers: versionHeaders,
        ...(read ? { signal: read } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw teamFileRefusal(response, "The team file is no longer available.");
      }
      const bytes = await readBoundedResponse(response, {
        maximumBytes: part === "preview" ? teamPreviewMaxBytes : teamUploadMaxBytes,
        ...(read ? { signal: read } : {}),
        sizeError: () => new Error("Team file exceeds its byte bound."),
      });
      owner?.assertCurrent();
      return new Blob([bytes], { type: fileType(metadata, part) });
    },
    uploadFile: async (upload: TeamFileUpload) => {
      const metadata = TeamBinaryUploadMetadataSchema.parse(upload.metadata);
      owner?.assertCurrent();
      const signal = owned(upload.signal);
      const response = await fetch(new URL(`/v1/team/files/upload/${upload.channelId}`, origin), {
        body: new Blob([upload.original, ...(upload.preview ? [upload.preview] : [])]),
        credentials: "include",
        headers: {
          ...versionHeaders,
          "content-type": "application/octet-stream",
          "x-opensteer-team-upload": JSON.stringify(metadata),
        },
        method: "POST",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw teamFileRefusal(response, "The team file could not be uploaded.");
      }
      const reply = await readBoundedResponse(response, {
        maximumBytes: teamUploadReplyMaxBytes,
        ...(signal ? { signal } : {}),
        sizeError: () => new Error("Team upload response exceeds its byte bound."),
      });
      const uploaded = TeamFileSchema.parse(JSON.parse(new TextDecoder().decode(reply)));
      owner?.assertCurrent();
      return uploaded;
    },
  };
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
    ...teamFiles(globalThis.fetch.bind(globalThis), origin),
    ...(input.notify ? { notify: input.notify } : {}),
  };
}

/**
 * A joined team on the desktop: every request, socket and file goes through
 * desktop main, pinned to the team's own Host, and main holds its credential.
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
  const fetch = createDesktopHostFetch(input.bridge, input.origin, deploymentId);
  const owned = ownedSignal(owner);
  return {
    scope: input.scope,
    ...(owner ? { owner } : {}),
    persistence: owner ? ownedLocalTeamPersistence(owner) : localTeamPersistence,
    rpc: createHttpHostApiClient({
      baseUrl: new URL(input.origin),
      fetch: async (url, init) => {
        owner?.assertCurrent();
        const signal = owned(init?.signal ?? undefined);
        const response = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
        owner?.assertCurrent();
        return response;
      },
      assertResponseCurrent: () => owner?.assertCurrent(),
      kind: "team",
      onAuthenticationRequired: () => undefined,
    }),
    connect: (): WebSocketClient => socket(`${input.origin.replace(/^http/u, "ws")}/v1/realtime`),
    ...teamFiles(fetch, input.origin, owner),
    ...(input.notify ? { notify: input.notify } : {}),
  };
}

function ownedLocalTeamPersistence(owner: TeamRuntimeOwner): TeamPersistence {
  // The key already names the team user, so a retired Account only needs to stop reading and writing.
  return {
    async load(scope) {
      owner.assertCurrent();
      return localTeamPersistence.load(scope);
    },
    async save(scope, state) {
      owner.assertCurrent();
      await localTeamPersistence.save(scope, state);
    },
    remove: (scope) => localTeamPersistence.remove(scope),
  };
}
