import { expect, it, vi } from "vitest";
import type { TeamSessionClient } from "@opensteer/client/team";
import type { TeamMessage } from "@opensteer/protocol";
const h = vi.hoisted(() => ({ convert: vi.fn(), write: vi.fn(), remove: vi.fn(), share: vi.fn() }));
vi.mock("./team-context.js", () => ({ dataUri: h.convert }));
vi.mock("expo-sharing", () => ({ shareAsync: h.share }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: class {
    exists = false;
    uri = "cache/staged";
    create() {
      this.exists = true;
    }
    delete() {
      this.exists = false;
      h.remove();
    }
    write = h.write;
  },
}));
import { shareTeamFile } from "./team-file-export.js";
it("withholds export and share after Account retirement during data URI conversion", async () => {
  const conversion = Promise.withResolvers<string>();
  h.convert.mockReturnValue(conversion.promise);
  const controller = new AbortController();
  const session = {
    file: async () => new Blob(["private A"]),
    owner: {
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
    },
  } as unknown as TeamSessionClient;
  const file = {
    id: "file",
    filename: "private.txt",
    mediaType: "text/plain",
  } as TeamMessage["attachments"][number];
  const sharing = shareTeamFile(session, file);
  await vi.waitFor(() => expect(h.convert).toHaveBeenCalledOnce(), { timeout: 1000 });
  controller.abort(new Error("Account changed"));
  conversion.resolve("data:text/plain;base64,cHJpdmF0ZSBB");
  await expect(sharing).rejects.toThrow("Account changed");
  expect(h.write).not.toHaveBeenCalled();
  expect(h.share).not.toHaveBeenCalled();
});

it.each(["write", "share", "completion"] as const)(
  "cleans the staged export after %s",
  async (stage) => {
    const { TeamRuntimeOwner } = await import("@opensteer/client/team");
    const owner = new TeamRuntimeOwner(null);
    h.convert.mockResolvedValue("data:text/plain;base64,QQ==");
    h.write.mockReset().mockImplementation(async () => {
      if (stage === "write") owner.retire();
    });
    h.share.mockReset().mockImplementation(async () => {
      if (stage === "share") owner.retire();
    });
    h.remove.mockClear();
    const session = { owner, file: async () => new Blob(["A"]) } as unknown as TeamSessionClient;
    const file = {
      id: "file",
      filename: "private.txt",
      mediaType: "text/plain",
    } as TeamMessage["attachments"][number];
    const sharing = shareTeamFile(session, file);
    if (stage === "write") await expect(sharing).rejects.toThrow("Account identity changed");
    else await sharing;
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.share).toHaveBeenCalledTimes(stage === "write" ? 0 : 1);
    owner.retire();
  },
);
