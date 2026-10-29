import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createId, ModelSelectionSchema, type Attachment, type WorkspaceId } from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import sharp from "sharp";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeCodex = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);

integration("chat attachment delivery through a whole deployment", () => {
  let stack: VerticalStack | undefined;
  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  }, 60_000);

  it("preserves binary originals, delivers native images, and restores only admitted files on continuation", async () => {
    const artifactDirectory =
      process.env.OPENSTEER_ATTACHMENT_E2E_OUTPUT ??
      join(tmpdir(), "opensteer-attachment-evidence", randomUUID());
    await mkdir(artifactDirectory, { recursive: true });
    const capture = join(artifactDirectory, "codex-wire.jsonl");
    const harnesses = new HarnessRegistry();
    harnesses.registerDriver(
      new CodexHarnessDriver({
        launch: {
          executable: process.execPath,
          arguments: [fakeCodex, "--scenario=attachments-vertical", `--capture=${capture}`],
        },
      }),
    );
    stack = await startVerticalStack({
      databaseUrl: databaseUrl!,
      catalogTimeoutMs: 10_000,
      runTimeoutMs: 20_000,
      harnesses,
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
    });
    const workspace = await stack.createWorkspace("Attachment verification");
    const bootstrap = await stack.api["bootstrap.get"]({});
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    expect(bootstrap.data.deploymentId).toBe((await stack.host.store.getDeployment())?.id);
    const threadId = await stack.createThread({
      workspaceId: workspace.id,
      title: "Verify attachment transport",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        options: {},
        providerId: "openai",
      }),
    });
    const binary = Buffer.alloc(2_097_169);
    for (let index = 0; index < binary.length; index++) binary[index] = index % 251;
    const png = await sharp({
      create: { width: 24, height: 16, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const file = await upload(stack, workspace.id, "data.bin", "application/octet-stream", binary);
    const image = await upload(stack, workspace.id, "red.png", "image/png", png);
    const unselected = await upload(
      stack,
      workspace.id,
      "private-draft.txt",
      "text/plain",
      Buffer.from("Never sent to the engine"),
    );
    const downloaded = await stack.api["attachment.content"]({ attachmentId: file.id });
    expect(downloaded.ok).toBe(true);
    if (!downloaded.ok) throw new Error(downloaded.error.message);
    expect(Buffer.from(downloaded.data.bytes)).toEqual(binary);

    const first = await stack.sendMessage({
      attachments: [reference(file)],
      text: "",
      threadId,
      workspaceId: workspace.id,
    });
    const firstReceipt: unknown = JSON.parse(first.assistantText);
    expect(firstReceipt).toEqual({
      files: [{ id: file.id, name: "data.bin", sha256: digest(binary) }],
      images: [],
      // The Run's thread context, then the file's message.
      inputTypes: ["text", "text"],
    });
    // A resumed session may reference files older than the dispatcher's 200-message window.
    await stack.host.store.database.transaction().execute(async (transaction) => {
      const thread = await transaction
        .selectFrom("threads")
        .select("nextMessageSequence")
        .where("id", "=", threadId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const source = await transaction
        .selectFrom("messages")
        .selectAll()
        .where("runId", "=", first.runId)
        .where("kind", "=", "assistant")
        .executeTakeFirstOrThrow();
      const next = BigInt(thread.nextMessageSequence);
      await transaction
        .insertInto("messages")
        .values(
          Array.from({ length: 205 }, (_, index) => ({
            ...source,
            id: createId("message"),
            sequence: String(next + BigInt(index)),
            content: sql<
              readonly unknown[]
            >`${JSON.stringify([{ type: "text", text: `Earlier conversation item ${index}` }])}::jsonb`,
          })),
        )
        .execute();
      await transaction
        .updateTable("threads")
        .set({ nextMessageSequence: String(next + 205n) })
        .where("id", "=", threadId)
        .execute();
    });
    // Another selection starts an engine of its own, which resumes the
    // conversation and must find every file again.
    await stack.updateThreadExecution(
      threadId,
      ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        options: { effort: "high" },
        providerId: "openai",
      }),
    );
    const second = await stack.sendMessage({
      attachments: [reference(image)],
      text: "Inspect this image.",
      threadId,
      workspaceId: workspace.id,
    });
    const secondReceipt: unknown = JSON.parse(second.assistantText);
    expect(secondReceipt).toEqual({
      files: expect.arrayContaining([
        { id: file.id, name: "data.bin", sha256: digest(binary) },
        { id: image.id, name: "red.png", sha256: digest(png) },
      ]),
      images: [image.id],
      inputTypes: expect.arrayContaining(["text", "localImage"]),
    });
    expect(JSON.stringify(secondReceipt)).not.toContain(unselected.id);
    expect(await readFile(capture, "utf8")).toContain('"method":"thread/resume"');

    const mutation = await stack.api["attachment.upload"](
      { attachmentId: file.id },
      { body: new Blob([Buffer.from("replacement")]) },
    );
    expect(mutation.ok).toBe(false);
    const anonymous = await fetch(
      new URL(
        `/v1/rpc/attachment.content?input=${encodeURIComponent(JSON.stringify({ attachmentId: file.id }))}`,
        stack.hostOrigin,
      ),
    );
    expect(anonymous.ok).toBe(false);
    await writeFile(
      join(artifactDirectory, "result.json"),
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          workspaceId: workspace.id,
          threadId,
          firstRunId: first.runId,
          secondRunId: second.runId,
          binaryBytes: binary.length,
          earlierConversationItems: 205,
          binarySha256: digest(binary),
          imageSha256: digest(png),
          firstReceipt,
          secondReceipt,
          unselectedAttachmentId: unselected.id,
          immutableOriginal: !mutation.ok,
          anonymousReadRefused: !anonymous.ok,
        },
        null,
        2,
      ),
    );
    console.info(`Attachment E2E evidence: ${artifactDirectory}`);
  }, 60_000);
});

async function upload(
  stack: VerticalStack,
  workspaceId: WorkspaceId,
  name: string,
  mediaType: string,
  bytes: Buffer,
): Promise<Attachment> {
  const reservation = await stack.api["commands.dispatch"]({
    type: "attachment.upload.create",
    idempotencyKey: randomUUID(),
    workspaceId,
    name,
    mediaType,
    sizeBytes: bytes.length,
  });
  if (!reservation.ok) throw new Error(reservation.error.message);
  if (reservation.data.type !== "attachment.upload.create")
    throw new Error("Unexpected reservation receipt");
  const uploaded = await stack.api["attachment.upload"](
    { attachmentId: reservation.data.attachment.id },
    { body: new Blob([Uint8Array.from(bytes)]) },
  );
  if (!uploaded.ok) throw new Error(uploaded.error.message);
  expect(uploaded.data.state).toBe("ready");
  expect(uploaded.data.sha256).toBe(digest(bytes));
  return uploaded.data;
}

function reference(attachment: Attachment) {
  return {
    type: "artifact" as const,
    artifactId: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
  };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
