import type { PrivateFilesystem } from "@opensteer/client/connections";
import { z } from "zod";
import { wantsAlerts, type PushRegistration } from "./push-registration.js";

const maxIntroFileBytes = 1_024;

const NotificationsIntroFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  shown: z.literal(true),
});

export interface NotificationsIntroFile {
  read(): Promise<boolean>;
  markShown(): Promise<void>;
}

/** Whether the intro has been shown on this phone. One that cannot be read has not. */
export function createNotificationsIntroFile(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): NotificationsIntroFile {
  return {
    async read() {
      try {
        const stored = await options.privateFiles.readFile(options.filePath, maxIntroFileBytes);
        if (stored === null) return false;
        return NotificationsIntroFileSchema.safeParse(
          JSON.parse(new TextDecoder().decode(stored)) as unknown,
        ).success;
      } catch {
        return false;
      }
    },
    async markShown() {
      await options.privateFiles.writeFileAtomic(
        options.filePath,
        JSON.stringify(NotificationsIntroFileSchema.parse({ schemaVersion: 1, shown: true })),
      );
    },
  };
}

/**
 * The one-time ask for notifications, the first time this phone is on a
 * computer's Home with a live connection. Only a phone the Account can still
 * reach and the system can still ask is offered it: a privately paired phone
 * has no Account to send through, a phone that already answered has
 * nothing to ask, and a person who turned alerts off is not asked. Sending a
 * first message still asks if this never did.
 */
export class NotificationsIntro {
  readonly #file: NotificationsIntroFile;
  readonly #registration: Pick<PushRegistration, "getSnapshot">;
  #shown: Promise<boolean> | null = null;

  constructor(options: {
    readonly file: NotificationsIntroFile;
    readonly registration: Pick<PushRegistration, "getSnapshot">;
  }) {
    this.#file = options.file;
    this.#registration = options.registration;
  }

  /** Whether the intro belongs on screen now, given where the person is. */
  async due(where: { readonly connected: boolean; readonly onHome: boolean }): Promise<boolean> {
    if (!where.connected || !where.onHome || !this.#askable()) return false;
    this.#shown ??= this.#file.read();
    return !(await this.#shown) && this.#askable();
  }

  /** Called as the intro appears: it is not offered again, even if the write fails. */
  async presented(): Promise<void> {
    this.#shown = Promise.resolve(true);
    await this.#file.markShown().catch(() => undefined);
  }

  #askable(): boolean {
    const { preferences, status } = this.#registration.getSnapshot();
    return status === "permission-undetermined" && wantsAlerts(preferences);
  }
}
