import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentCache } from "./attachment-cache.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const bytes = Buffer.from("verified attachment bytes");
const transport = { hostOrigin: new URL("https://host.example"), mode: "development" as const };
const digest = createHash("sha256").update(bytes).digest("hex");
const attachment = {
  createdAt: "2026-09-24T18:00:00.000Z",
  expiresAt: "2026-09-25T18:00:00.000Z",
  height: null,
  id: "att_11111111-1111-4111-8111-111111111111",
  messageId: "msg_11111111-1111-4111-8111-111111111111",
  name: "report.txt",
  mediaType: "text/plain",
  kind: "file" as const,
  state: "ready" as const,
  sizeBytes: bytes.length,
  sha256: digest,
  threadId: "thr_11111111-1111-4111-8111-111111111111",
  uploaderId: "usr_11111111-1111-4111-8111-111111111111",
  width: null,
  workspaceId: "wsp_11111111-1111-4111-8111-111111111111",
};

describe("Runner attachment delivery", () => {
  it("keeps an empty Thread directory ready for the first file in an active steer", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-attachment-e2e-"));
    roots.push(root);
    let admitted = false;
    const cache = new AttachmentCache({
      root: join(root, "cache"),
      transport,
      fetch: async (input) =>
        String(input).endsWith("/content")
          ? new Response(bytes)
          : Response.json({ attachments: admitted ? [attachment] : [], nextCursor: null }),
    });
    const input = {
      plan: { token: "secret" },
      threadId: "thr_11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    };
    expect((await cache.prepare(input)).size).toBe(0);
    expect((await stat(join(cache.root, input.threadId))).isDirectory()).toBe(true);
    admitted = true;
    const steered = await cache.prepare(input);
    expect(await readFile(steered.get(attachment.id)!.path)).toEqual(bytes);
  });
  it("pages the scoped inventory, restores old files, and verifies a mutated cache on every Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-attachment-e2e-"));
    roots.push(root);
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("?after=att_22222222-2222-4222-8222-222222222222")) {
        return Response.json({ attachments: [attachment], nextCursor: null });
      }
      if (url.endsWith("/content")) return new Response(bytes);
      return Response.json({
        attachments: [],
        nextCursor: "att_22222222-2222-4222-8222-222222222222",
      });
    });
    const cache = new AttachmentCache({ root: join(root, "cache"), fetch, transport });
    const plan = { token: "secret" };
    const first = await cache.prepare({
      plan,
      threadId: "thr_11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    });
    const path = first.get(attachment.id)?.path;
    expect(path).toBeDefined();
    expect(await readFile(path!)).toEqual(bytes);
    expect(requests).toContain(
      "https://host.example/v1/runner/attachments?after=att_22222222-2222-4222-8222-222222222222",
    );

    await chmod(path!, 0o600);
    await writeFile(path!, Buffer.from("corrupted attachment bytes"));
    const second = await cache.prepare({
      plan,
      threadId: "thr_11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    });
    expect(second.get(attachment.id)?.path).toBe(path);
    expect(await readFile(path!)).toEqual(bytes);
    expect(requests.filter((url) => url.endsWith("/content"))).toHaveLength(2);
  });

  it("rejects a corrupt Host response without installing bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-attachment-e2e-"));
    roots.push(root);
    const cache = new AttachmentCache({
      root: join(root, "cache"),
      transport,
      fetch: async (input) =>
        String(input).endsWith("/content")
          ? new Response(Buffer.from("tampered attachment bytes"))
          : Response.json({ attachments: [attachment], nextCursor: null }),
    });
    await expect(
      cache.prepare({
        plan: { token: "secret" },
        threadId: "thr_11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/checksum|digest|hash/i);
  });
});
