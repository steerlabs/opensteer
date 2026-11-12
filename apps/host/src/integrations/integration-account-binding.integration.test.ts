import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { describeStore, type StoreFixture } from "@opensteer/database/test-support/store";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  IntegrationAccountBindingSchema,
  resolveIntegrationAccountBinding,
} from "./integration-account-binding.js";
const issuer = "https://accounts.opensteer.test";
describeStore("personal integration Account binding", (it) => {
  it("preserves the active personal link generation and follows replacement", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.createRunFixture("account-binding");
    const { database } = storeFixture;
    const subject = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`),
      linkGeneration = "P".repeat(43);
    await insertPersonalLink(database, { linkGeneration, state: "active", subject });
    const input = { database, ownerUserId: fixture.userId };
    expect(
      IntegrationAccountBindingSchema.parse(await resolveIntegrationAccountBinding(input)),
    ).toEqual({ issuer, linkGeneration, subject });
    await database
      .updateTable("personalRemoteAccountLink")
      .set({ linkGeneration: "Q".repeat(43), updatedAt: new Date() })
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirstOrThrow();
    expect(
      IntegrationAccountBindingSchema.parse(await resolveIntegrationAccountBinding(input)),
    ).toEqual({ issuer, linkGeneration: "Q".repeat(43), subject });
  });
  it("rejects absent or inactive personal links, disabled owners and another identity", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.createRunFixture("account-binding-ineligible");
    const { database } = storeFixture,
      subject = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`),
      input = { database, ownerUserId: fixture.userId };
    await expect(resolveIntegrationAccountBinding(input)).resolves.toBeNull();
    await insertPersonalLink(database, {
      linkGeneration: "P".repeat(43),
      state: "activating",
      subject,
    });
    await expect(resolveIntegrationAccountBinding(input)).resolves.toBeNull();
    await database
      .updateTable("personalRemoteAccountLink")
      .set({ state: "active", updatedAt: new Date() })
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirstOrThrow();
    await expect(
      resolveIntegrationAccountBinding({ ...input, ownerUserId: createId("user") }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await database
      .updateTable("users")
      .set({ disabledAt: new Date(), updatedAt: new Date() })
      .where("id", "=", fixture.userId)
      .executeTakeFirstOrThrow();
    await expect(resolveIntegrationAccountBinding(input)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
async function insertPersonalLink(
  database: StoreFixture["database"],
  input: {
    readonly linkGeneration: string;
    readonly state: "activating" | "active";
    readonly subject: string;
  },
): Promise<void> {
  const now = new Date("2026-09-18T12:00:00.000Z");
  await database
    .insertInto("personalRemoteAccountLink")
    .values({
      challengeId: `phc_${randomUUID()}`,
      grantId: `phg_${randomUUID()}`,
      hostCredential: `osc_${"c".repeat(43)}`,
      issuer,
      linkGeneration: input.linkGeneration,
      linkedAt: now,
      singletonKey: "opensteer-account",
      state: input.state,
      subject: input.subject,
      updatedAt: now,
    })
    .executeTakeFirstOrThrow();
}
