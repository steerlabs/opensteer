import { withTimeout } from "@opensteer/shared/withTimeout";
// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  MockTeamHost,
  TeamRuntimeOwner,
  TeamSessionClient,
  createMemoryTeamPersistence,
  type TeamSessionOptions,
} from "@opensteer/client/team";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { TeamFileSchema } from "@opensteer/protocol";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { desktopTeamSession } from "../../../web/src/team/team-transports.js";
import { TeamPreviewUrls } from "../../../web/src/team/preview-urls.js";
import { teamFilePersistence } from "./mobile-teams.js";
import { useFocusedRead } from "./knowledge-parts.js";

vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (value: object) => value },
  Platform: { OS: "ios", select: () => 0 },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../ui/primitives.js", () => ({}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const kinds = [
  "binary/file transfer",
  "preview",
  "cache",
  "read hook",
  "persistence write",
] as const;
it.each(kinds)("retires owned %s before its delivery boundary", async (kind) => {
  const owner = new TeamRuntimeOwner({ issuer: "https://accounts.test", subject: "A" });
  const host = new MockTeamHost();
  const scope = { teamDeploymentId: host.teamId, userId: host.userId };
  const delivered = vi.fn();
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let pending: Promise<unknown>;
  let finish = () => gate.resolve();
  let verify = () => {};
  let cleanup = () => {};
  const file = TeamFileSchema.parse({
    id: createId("teamBlob"),
    channelId: createId("teamChannel"),
    filename: "private.txt",
    mediaType: "text/plain",
    sizeBytes: 1,
    sha256: "a".repeat(64),
    preview: { mediaType: "image/png", sizeBytes: 1 },
  });
  const options: TeamSessionOptions = {
    scope,
    owner,
    rpc: host.rpc,
    connect: host.connect,
    persistence: createMemoryTeamPersistence(),
    readFile: async () => {
      started.resolve();
      await gate.promise;
      return new Blob(["A"]);
    },
  };
  try {
    if (kind === "binary/file transfer") {
      const closed = vi.fn(async () => ({ ok: true, data: null }));
      const bridge = {
        onHostWebSocketEvent: () => () => {},
        hostBinaryOpen: async () => ({ ok: true, data: { transferId: "transfer" } }),
        hostBinaryRead: async () => {
          started.resolve();
          await gate.promise;
          return {
            ok: true,
            data: {
              status: 200,
              bytes: new Uint8Array([65]),
              contentType: "application/octet-stream",
              done: true,
            },
          };
        },
        hostBinaryClose: closed,
      } as unknown as OpensteerDesktopBridge;
      const session = desktopTeamSession({ bridge, scope, origin: host.origin, owner });
      pending = session.readFile!(file, "original").then(delivered);
      verify = () => expect(closed).toHaveBeenCalled();
    } else if (kind === "preview") {
      const urls = new TeamPreviewUrls(owner);
      const create = vi.fn(() => "blob:private-A");
      vi.stubGlobal(
        "URL",
        class extends URL {
          static override createObjectURL = create;
          static override revokeObjectURL = vi.fn();
        },
      );
      pending = urls.load("private", async () => {
        started.resolve();
        await gate.promise;
        return new Blob(["A"]);
      });
      verify = () => {
        expect(create).not.toHaveBeenCalled();
        expect(urls.getSnapshot().size).toBe(0);
      };
    } else if (kind === "cache") {
      let session: TeamSessionClient;
      owner.own(() => session.dispose());
      session = new TeamSessionClient({ ...options, readFile: async () => new Blob(["A"]) });
      await session.load(false);
      expect(session.getSnapshot().bootstrap).not.toBeNull();
      await session.file(file, true);
      const cache = owner.cache<string, string>();
      cache.set("note", "private A");
      pending = owner
        .run(async () => {
          started.resolve();
          await gate.promise;
          return "private A";
        })
        .then((value) => {
          cache.set("late", value);
          delivered(value);
        });
      verify = () => {
        expect(cache.size).toBe(0);
        expect(session.getSnapshot().bootstrap).toBeNull();
      };
    } else if (kind === "read hook") {
      const session = new TeamSessionClient(options);
      const node = document.createElement("div"),
        root = createRoot(node);
      function Note({ current }: { current: TeamSessionClient | null }) {
        const read = useFocusedRead(
          current,
          async () => {
            started.resolve();
            await gate.promise;
            owner.assertCurrent();
            return "Private note A";
          },
          "private-note",
        );
        return <p>{read.value}</p>;
      }
      act(() => root.render(<Note current={session} />));
      pending = gate.promise;
      finish = () => {
        act(() => root.render(<Note current={null} />));
        gate.resolve();
      };
      verify = () => expect(node.textContent).not.toContain("Private note A");
      cleanup = () => act(() => root.unmount());
    } else if (kind === "persistence write") {
      const files = new MemoryPrivateFilesystem();
      const write = files.writeFileAtomic.bind(files);
      vi.spyOn(files, "writeFileAtomic").mockImplementation(async (...args) => {
        started.resolve();
        await gate.promise;
        await write(...args);
      });
      const persistence = teamFilePersistence(owner.files(files), "/private/A");
      pending = persistence.save(scope, { drafts: { private: "A" }, pending: [] }).then(delivered);
      verify = () =>
        expect(files.text(`/private/A/${scope.teamDeploymentId}.${scope.userId}.json`)).toBeNull();
    } else throw new Error(`Unknown boundary: ${kind}`);
    const settled = pending.catch(() => undefined);
    await withTimeout(started.promise, 1000, {
      timeoutError: () => new Error(`The ${kind} operation never reached its boundary.`),
    });
    owner.retire();
    await act(async () => {
      finish();
      await withTimeout(settled, 1000, {
        timeoutError: () => new Error(`The ${kind} operation did not settle after retirement.`),
      });
    });
    expect(delivered).not.toHaveBeenCalled();
    verify();
  } finally {
    gate.resolve();
    owner.retire();
    cleanup();
    host.dispose();
  }
});
