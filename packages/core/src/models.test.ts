import { describe, expect, it } from "vitest";
import { createId } from "./ids.js";
import {
  MessageContentSchema,
  MessageSchema,
  ProviderContinuationIdentitySchema,
  runnerRunsItsDeployment,
  WorkspaceSchema,
  messageContentMaxSerializedBytes,
  messageAuthorCanWriteKind,
  type MessageAuthor,
  type MessageKind,
} from "./models.js";

describe("the Runner that is its Deployment", () => {
  it("names only a Personal Deployment's own main Runner", () => {
    const personalMain = {
      deploymentIsPersonal: true,
      ownerKind: "deployment",
      runnerKind: "main",
    } as const;

    expect(runnerRunsItsDeployment(personalMain)).toBe(true);
    expect(runnerRunsItsDeployment({ ...personalMain, deploymentIsPersonal: false })).toBe(false);
    expect(runnerRunsItsDeployment({ ...personalMain, ownerKind: "user" })).toBe(false);
    expect(runnerRunsItsDeployment({ ...personalMain, runnerKind: "local" })).toBe(false);
    expect(runnerRunsItsDeployment({ ...personalMain, runnerKind: "managed" })).toBe(false);
  });
});

describe("provider continuation privacy", () => {
  it("accepts only the Runner's opaque projection", () => {
    expect(
      ProviderContinuationIdentitySchema.safeParse({
        continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
        driverKind: "codex",
      }).success,
    ).toBe(true);
    expect(
      ProviderContinuationIdentitySchema.safeParse({
        continuationKey: "codex:home:/Users/person/.codex",
        driverKind: "codex",
      }).success,
    ).toBe(false);
  });
});

describe("durable message content", () => {
  it("enforces the serialized byte ceiling for multibyte text", () => {
    const accepted = [{ text: "😀".repeat(84 * 1_024), type: "text" as const }];
    const rejected = [{ text: "😀".repeat(90 * 1_024), type: "text" as const }];

    expect(new TextEncoder().encode(JSON.stringify(accepted)).byteLength).toBeLessThan(
      messageContentMaxSerializedBytes,
    );
    expect(MessageContentSchema.safeParse(accepted).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(rejected)).byteLength).toBeGreaterThan(
      messageContentMaxSerializedBytes,
    );
    expect(MessageContentSchema.safeParse(rejected).success).toBe(false);
  });
});

describe("durable message authorship", () => {
  it("uses the canonical author-kind compatibility rule in MessageSchema", () => {
    const authors: readonly MessageAuthor[] = [
      { displayName: "User", kind: "human", principalId: "principal:test" },
      {
        displayName: "Research agent",
        kind: "agent",
        runId: createId("run"),
        threadId: createId("thread"),
        workspaceId: createId("workspace"),
        workspaceName: "Research",
      },
      {
        displayName: "Webhook",
        kind: "trigger",
        occurrenceId: createId("triggerOccurrence"),
        source: "webhook",
        triggerId: createId("trigger"),
      },
      { cause: "continuation", kind: "platform" },
    ];
    const kinds: readonly MessageKind[] = ["input", "assistant", "run-result", "continuation"];

    for (const author of authors) {
      for (const kind of kinds) {
        const expected = messageAuthorCanWriteKind(author, kind);
        expect(
          MessageSchema.safeParse({
            author,
            content: [{ text: "Test", type: "text" }],
            createdAt: new Date().toISOString(),
            id: createId("message"),
            kind,
            runId: null,
            sequence: "1",
            threadId: createId("thread"),
          }).success,
        ).toBe(expected);
      }
    }
  });
});

describe("Workspace storage invariants", () => {
  const baseWorkspace = {
    createdAt: "2026-08-12T12:00:00.000Z",
    createdBy: "usr_00000000-0000-4000-8000-000000000001",
    id: "wsp_00000000-0000-4000-8000-000000000002",
    homeThreadId: createId("thread"),
    icon: null,
    kind: "main",
    name: "Main",
    status: "ready",
    storageIssue: null,
    updatedAt: "2026-08-12T12:00:00.000Z",
  } as const;

  it("requires local directories to use host filesystem capacity", () => {
    const backing = {
      bindingId: "wbd_00000000-0000-4000-8000-000000000003",
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId: "env_00000000-0000-4000-8000-000000000004",
      storageAuthorityId: createId("storageAuthority"),
    } as const;
    expect(
      WorkspaceSchema.safeParse({
        ...baseWorkspace,
        backing,
        capacityPolicy: { kind: "host-filesystem" },
      }).success,
    ).toBe(true);
    expect(
      WorkspaceSchema.safeParse({
        ...baseWorkspace,
        backing,
        capacityPolicy: {
          blockHardLimitBytes: 1_000,
          inodeHardLimit: 100,
          kind: "hard-quota",
        },
      }).success,
    ).toBe(false);
  });

  it("requires PortableFS to use an enforceable hard quota", () => {
    const backing = {
      generation: 1,
      kind: "portablefs",
      serviceId: "portablefs-test",
      volumeId: "volume_test",
    } as const;
    expect(
      WorkspaceSchema.safeParse({
        ...baseWorkspace,
        backing,
        capacityPolicy: {
          blockHardLimitBytes: 1_000,
          inodeHardLimit: 100,
          kind: "hard-quota",
        },
      }).success,
    ).toBe(true);
    expect(
      WorkspaceSchema.safeParse({
        ...baseWorkspace,
        backing,
        capacityPolicy: { kind: "host-filesystem" },
      }).success,
    ).toBe(false);
  });
});
