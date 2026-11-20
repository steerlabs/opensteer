import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  canonicalWorkAuditRecord,
  defaultWorkPolicy,
  workAuditGenesisHash,
  workAuditSigningBytes,
  WorkAuditPushSchema,
  WorkAuditRecordSchema,
  WorkPolicyClaimsSchema,
  WorkPolicySchema,
  workPolicyAllowsGrant,
} from "./organizations.js";

const assignmentId = "was_00000000-0000-4000-8000-000000000001";
const instant = "2026-11-20T12:30:30.000Z";

describe("work policy", () => {
  it("has the four default switches and excludes everything when tasks are disabled", () => {
    expect(WorkPolicySchema.parse(defaultWorkPolicy)).toEqual({
      externalMaxMode: "approval-required",
      allowEverything: false,
      allowTasks: false,
      devices: "cloud-computer-only",
    });
    expect(workPolicyAllowsGrant(defaultWorkPolicy, { scope: "selected", tasks: false })).toBe(
      true,
    );
    expect(workPolicyAllowsGrant(defaultWorkPolicy, { scope: "selected", tasks: true })).toBe(
      false,
    );
    expect(
      workPolicyAllowsGrant(
        { ...defaultWorkPolicy, allowEverything: true },
        { scope: "everything" },
      ),
    ).toBe(false);
    expect(
      workPolicyAllowsGrant(
        { ...defaultWorkPolicy, allowEverything: true, allowTasks: true },
        { scope: "everything" },
      ),
    ).toBe(true);
    expect(WorkPolicySchema.safeParse({ ...defaultWorkPolicy, customRules: [] }).success).toBe(
      false,
    );
  });

  it("separates signed policy from expiring credentials", () => {
    const deploymentId = createId("deployment");
    const document = {
      tokenUse: "opensteer-work-policy",
      iss: "https://account.example.com",
      aud: deploymentId,
      iat: 123,
      assignmentId,
      deploymentId,
      policy: defaultWorkPolicy,
      revision: 2,
      state: "offboarding",
    } as const;
    expect(WorkPolicyClaimsSchema.parse(document)).toEqual(document);
    expect(WorkPolicyClaimsSchema.safeParse({ ...document, exp: 124 }).success).toBe(false);
  });
});

describe("work audit records", () => {
  const record = { kind: "policy.applied", sequence: 1, at: instant, revision: 1 } as const;
  const batch = {
    assignmentId,
    fromSequence: 1,
    records: [record],
    headHash: workAuditGenesisHash,
    signature: "A".repeat(86),
  };

  it.each(["url", "title", "prompt", "arguments", "result", "label", "path", "screenshot"])(
    "rejects a %s field in an otherwise valid record",
    (key) =>
      expect(WorkAuditRecordSchema.safeParse({ ...record, [key]: "private" }).success).toBe(false),
  );

  it("validates contiguous sequences and limits record kinds and values", () => {
    expect(WorkAuditPushSchema.parse(batch)).toEqual(batch);
    expect(
      WorkAuditPushSchema.safeParse({ ...batch, records: [{ ...record, sequence: 2 }] }).success,
    ).toBe(false);
    expect(WorkAuditPushSchema.safeParse({ ...batch, fromSequence: 2 }).success).toBe(false);
    expect(WorkAuditRecordSchema.safeParse({ ...record, kind: "file.read" }).success).toBe(false);
    expect(WorkAuditRecordSchema.safeParse({ ...record, at: "today" }).success).toBe(false);
  });

  it("canonicalizes flat fields and binds the full range to the signature", () => {
    expect(canonicalWorkAuditRecord(record)).toBe(
      `{"at":"${instant}","kind":"policy.applied","revision":1,"sequence":1}`,
    );
    const message = workAuditSigningBytes(WorkAuditPushSchema.parse(batch));
    expect(new TextDecoder().decode(message)).toBe(
      `opensteer-work-audit-v1\0["${assignmentId}",1,1,"${workAuditGenesisHash}"]`,
    );
  });
});
