import { harnessSessionBrokenFailureCode, harnessUsageLimitFailureCode } from "@opensteer/core";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { watchAntigravityPromptOutcome } from "./turn-outcome.js";

const temporaryDirectories: string[] = [];
const sessionId = "10000000-0000-4000-8000-000000000001";

function appendStep(dbPath: string, idx: number, stepType: number, payload: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
    );
    db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(
      idx,
      stepType,
      Buffer.from(payload, "utf8"),
    );
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Antigravity SQLite turn outcome inspection", () => {
  it("classifies a missing Claude thinking signature as harness_session_broken", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-outcome-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const conversations = join(profileDirectory, "antigravity-acp", "conversations");
    await mkdir(conversations, { recursive: true });
    const dbPath = join(conversations, `${sessionId}.db`);
    appendStep(dbPath, 0, 15, "previous reply");

    const check = await watchAntigravityPromptOutcome(profileDirectory, sessionId);
    appendStep(
      dbPath,
      1,
      17,
      'INVALID_ARGUMENT (code 400): {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"}}',
    );

    const failure = await check(
      { stopReason: "end_turn" },
      {
        assistantText:
          '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"}}',
      },
    );

    expect(failure?.discardAssistant).toBe(true);
    expect(failure?.error).toMatchObject({
      code: harnessSessionBrokenFailureCode,
      retryable: true,
    });
  });

  it("classifies QUOTA_EXHAUSTED and refusal stop reasons as harness_usage_limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-quota-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const conversations = join(profileDirectory, "antigravity-acp", "conversations");
    await mkdir(conversations, { recursive: true });
    const dbPath = join(conversations, `${sessionId}.db`);

    const check = await watchAntigravityPromptOutcome(profileDirectory, sessionId);
    appendStep(
      dbPath,
      0,
      17,
      "Error 429, Message: Quota exhausted, Status: RESOURCE_EXHAUSTED [reason:QUOTA_EXHAUSTED]",
    );

    const failure = await check({ stopReason: "end_turn" }, { assistantText: "Quota exhausted" });
    expect(failure?.error).toMatchObject({
      code: harnessUsageLimitFailureCode,
      retryable: true,
    });
  });

  it("gives INVALID_THINKING_SIGNATURE precedence over refusal and does not misclassify bare refusals as quota limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-refusal-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const conversations = join(profileDirectory, "antigravity-acp", "conversations");
    await mkdir(conversations, { recursive: true });
    const dbPath = join(conversations, `${sessionId}.db`);

    const checkRefusalOnly = await watchAntigravityPromptOutcome(profileDirectory, sessionId);
    const refusalFailure = await checkRefusalOnly({ stopReason: "refusal" }, { assistantText: "" });
    expect(refusalFailure?.error).toMatchObject({
      code: "harness_error",
      retryable: false,
    });

    const checkPoisoned = await watchAntigravityPromptOutcome(profileDirectory, sessionId);
    appendStep(
      dbPath,
      0,
      17,
      "INVALID_ARGUMENT (code 400): messages.1.content.0.thinking.signature: Field required",
    );
    const poisonedFailure = await checkPoisoned({ stopReason: "refusal" }, { assistantText: "" });
    expect(poisonedFailure?.error).toMatchObject({
      code: harnessSessionBrokenFailureCode,
      retryable: true,
    });
  });

  it("ignores pre-existing error steps when the new prompt succeeds cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-prior-error-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const conversations = join(profileDirectory, "antigravity-acp", "conversations");
    await mkdir(conversations, { recursive: true });
    const dbPath = join(conversations, `${sessionId}.db`);
    appendStep(
      dbPath,
      0,
      17,
      "INVALID_ARGUMENT (code 400): messages.1.content.0.thinking.signature: Field required",
    );

    const check = await watchAntigravityPromptOutcome(profileDirectory, sessionId);
    appendStep(dbPath, 1, 15, "healthy reply");

    expect(
      await check({ stopReason: "end_turn" }, { assistantText: "healthy reply" }),
    ).toBeUndefined();
  });

  it("refuses to read a symlinked session database", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-symlink-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const conversations = join(profileDirectory, "antigravity-acp", "conversations");
    await mkdir(conversations, { recursive: true });
    const outside = join(root, "outside.db");
    appendStep(
      outside,
      0,
      17,
      "INVALID_ARGUMENT (code 400): messages.1.content.0.thinking.signature: Field required",
    );
    await symlink(outside, join(conversations, `${sessionId}.db`));

    const check = await watchAntigravityPromptOutcome(profileDirectory, sessionId);
    expect(await check({ stopReason: "end_turn" }, { assistantText: "" })).toBeUndefined();
  });

  it("does not truncate a SQLite failure message mid-secret before named-secret redaction (X4)", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-truncate-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const conversations = join(profileDirectory, "antigravity-acp", "conversations");
    await mkdir(conversations, { recursive: true });
    const dbPath = join(conversations, `${sessionId}.db`);

    const secret = "synthetic-boundary-secret-9M4X";
    const check = await watchAntigravityPromptOutcome(profileDirectory, sessionId);
    appendStep(dbPath, 0, 17, `INTERNAL (code 500): ${"x".repeat(1_990)}${secret} tail`);

    const failure = await check({ stopReason: "end_turn" }, { assistantText: "" });
    expect(failure?.error.message).toContain(secret);
  });
});
