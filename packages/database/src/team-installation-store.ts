import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import {
  HostAccountAdoptionBundleSchema,
  type HostAccountAdoptionBundle,
} from "@opensteer/control-plane-protocol";
import type { DeploymentId } from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export class TeamInstallationStore {
  readonly #key: Buffer;
  readonly #aad: Buffer;
  readonly deploymentId: DeploymentId;
  constructor(authSecret: string, deploymentId: DeploymentId) {
    this.deploymentId = deploymentId;
    this.#key = Buffer.from(
      hkdfSync("sha256", authSecret, "", "opensteer-team-installation-v1", 32),
    );
    this.#aad = Buffer.from(JSON.stringify([deploymentId, 1]));
  }
  async install(t: Transaction<DatabaseSchema>, input: HostAccountAdoptionBundle) {
    const bundle = HostAccountAdoptionBundleSchema.parse(input);
    if (bundle.deployment.deploymentId !== this.deploymentId)
      throw new Error("Account bundle deployment mismatch");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(this.#aad);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(bundle), "utf8"),
      cipher.final(),
    ]);
    const sealedAccountBundle = Buffer.concat([
      Buffer.from([1]),
      nonce,
      cipher.getAuthTag(),
      encrypted,
    ]);
    await t
      .insertInto("teamInstallation")
      .values({ singletonKey: "team", sealedAccountBundle })
      .onConflict((c) =>
        c.column("singletonKey").doUpdateSet({ sealedAccountBundle, updatedAt: new Date() }),
      )
      .execute();
  }
  async load(database: Kysely<DatabaseSchema>): Promise<HostAccountAdoptionBundle | undefined> {
    const row = await database
      .selectFrom("teamInstallation")
      .select("sealedAccountBundle")
      .where("singletonKey", "=", "team")
      .executeTakeFirst();
    if (!row) return undefined;
    const sealed = row.sealedAccountBundle;
    if (sealed.length < 30 || sealed[0] !== 1) throw new Error("Invalid sealed account bundle");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, sealed.subarray(1, 13));
    decipher.setAAD(this.#aad);
    decipher.setAuthTag(sealed.subarray(13, 29));
    const bundle = HostAccountAdoptionBundleSchema.parse(
      JSON.parse(
        Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]).toString("utf8"),
      ),
    );
    if (bundle.deployment.deploymentId !== this.deploymentId)
      throw new Error("Account bundle deployment mismatch");
    return bundle;
  }
}
