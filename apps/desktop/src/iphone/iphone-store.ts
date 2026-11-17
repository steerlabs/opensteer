import { IphoneScreenAttachCommandSchema } from "@opensteer/protocol";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { DesktopPrivateFilesystem } from "../secrets/desktop-private-files.js";
import { iphoneRunnerOwnerSchema } from "@opensteer/protocol/iphone-bridge";

const identity = z.string().min(1).max(128);
export const iphoneMappingSchema = iphoneRunnerOwnerSchema.extend({
  localPhoneId: identity,
  udid: identity,
  setupId: identity,
  userLabel: z.string().min(1).max(120),
  phase: z.enum(["reserved", "pending-attach", "bound", "pending-detach"]),
  deviceId: identity.nullable(),
  driverGeneration: z.number().int().positive().nullable(),
  wifiEnabledByOpensteer: z.boolean(),
  setupComplete: z.boolean().default(false),
  attachTarget: IphoneScreenAttachCommandSchema.shape.target.nullable().default(null),
  detachKey: identity.nullable().default(null),
});
export type IphoneMapping = z.infer<typeof iphoneMappingSchema>;
const documentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mappings: z.array(iphoneMappingSchema).max(64),
});

export class IphoneServiceError extends Error {
  readonly code: string;
  readonly effect: "not-started" | "submitted" | "unknown";
  constructor(code: string, effect: "not-started" | "submitted" | "unknown" = "not-started") {
    super(code);
    this.name = "IphoneServiceError";
    this.code = code;
    this.effect = effect;
  }
}

export class IphoneStore {
  readonly #files: DesktopPrivateFilesystem;
  readonly #reservations: DesktopPrivateFilesystem;
  readonly #file: string;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(files: DesktopPrivateFilesystem, reservations: DesktopPrivateFilesystem = files) {
    this.#files = files;
    this.#reservations = reservations;
    this.#file = path.join(files.root, "iphone", "mappings.v1.json");
  }
  async records(): Promise<IphoneMapping[]> {
    await this.#tail;
    return this.#read();
  }
  async #read(): Promise<IphoneMapping[]> {
    const content = await this.#files.readFile(this.#file, 128 * 1024);
    return content ? documentSchema.parse(JSON.parse(content.toString("utf8"))).mappings : [];
  }
  #reservation(udid: string): string {
    return path.join(
      this.#reservations.root,
      "reservations",
      `${createHash("sha256").update(udid).digest("hex")}.json`,
    );
  }
  async #reservationMatches(record: IphoneMapping): Promise<boolean> {
    const content = await this.#reservations.readFile(this.#reservation(record.udid), 8192);
    if (!content) return false;
    const stored = iphoneMappingSchema.parse(JSON.parse(content.toString("utf8")));
    return (
      stored.udid === record.udid &&
      stored.setupId === record.setupId &&
      stored.deploymentId === record.deploymentId &&
      stored.hostInstanceId === record.hostInstanceId &&
      stored.runnerId === record.runnerId
    );
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
  async #write(records: IphoneMapping[]): Promise<void> {
    await this.#files.ensureDirectory(path.dirname(this.#file));
    await this.#files.writeFileAtomic(
      this.#file,
      JSON.stringify(documentSchema.parse({ schemaVersion: 1, mappings: records })),
    );
  }
  reserve(value: IphoneMapping): Promise<IphoneMapping> {
    return this.#serialize(async () => {
      const record = iphoneMappingSchema.parse(value);
      const current = await this.#read();
      const previous = current.find(({ udid }) => udid === record.udid);
      if (previous) {
        if (
          previous.deploymentId !== record.deploymentId ||
          previous.hostInstanceId !== record.hostInstanceId ||
          previous.runnerId !== record.runnerId ||
          previous.setupId !== record.setupId
        )
          throw new IphoneServiceError("owned-by-another-deployment");
        return previous;
      }
      await this.#reservations.ensureDirectory(path.dirname(this.#reservation(record.udid)));
      try {
        await this.#reservations.writeFileExclusive(
          this.#reservation(record.udid),
          JSON.stringify(record),
        );
      } catch {
        throw new IphoneServiceError("owned-by-another-deployment");
      }
      try {
        await this.#write([...current, record]);
      } catch (error) {
        await this.#reservations.removeFile(this.#reservation(record.udid));
        throw error;
      }
      return record;
    });
  }
  save(value: IphoneMapping): Promise<void> {
    return this.#serialize(async () => {
      const record = iphoneMappingSchema.parse(value);
      const current = await this.#read();
      const index = current.findIndex(
        ({ udid, setupId }) => udid === record.udid && setupId === record.setupId,
      );
      if (index < 0) throw new IphoneServiceError("candidate-gone");
      if (!(await this.#reservationMatches(record)))
        throw new IphoneServiceError("owned-by-another-deployment");
      await this.#reservations.writeFileAtomic(
        this.#reservation(record.udid),
        JSON.stringify(record),
      );
      current[index] = record;
      await this.#write(current);
    });
  }
  remove(record: IphoneMapping): Promise<void> {
    return this.#serialize(async () => {
      const current = await this.#read();
      const matched = current.find(
        ({ udid, setupId }) => udid === record.udid && setupId === record.setupId,
      );
      if (!matched) return;
      if (await this.#reservationMatches(record))
        await this.#reservations.removeFile(this.#reservation(record.udid));
      await this.#write(current.filter((entry) => entry !== matched));
    });
  }
}
