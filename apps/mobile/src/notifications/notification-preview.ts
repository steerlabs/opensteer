import type {
  NotificationPreviewNative,
  PreviewKey,
} from "../../modules/notification-preview/index.js";
import type { PushRegistration } from "./push-registration.js";

// W2 integration: these are the exact SPEC §5 command shapes. Keep local until
// the preview schemas land in core/protocol; no shared contract is defined here.
export type PreviewCommand =
  | ({
      readonly type: "notification.preview.register";
      readonly installationId: string;
      readonly accountId: string;
    } & PreviewKey)
  | {
      readonly type: "notification.preview.unregister";
      readonly installationId: string;
      readonly keyId: string;
    };
export interface PreviewAttachment {
  readonly deploymentId: string;
  readonly capabilities: readonly string[];
  readonly current: () => boolean;
  readonly dispatch: (command: PreviewCommand) => Promise<unknown>;
}
export class NotificationPreviews {
  #generation = 0;
  #attachment: PreviewAttachment | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #accountBlocked = false;
  #rotationRequired = new Set<string>();
  unregister: ((deploymentId: string, command: PreviewCommand) => Promise<unknown>) | null = null;
  #blocked = new Set<string>();
  constructor(
    readonly native: NotificationPreviewNative | null,
    readonly push: PushRegistration,
    readonly subject: () => Promise<string | null>,
  ) {}
  start(): Promise<void> {
    return this.#run(async () => {
      if (this.native?.notificationPreviewVersion === 1) await this.native.prepare();
    }).catch(() => this.push.previewFailed());
  }
  attach(attachment: PreviewAttachment): void {
    this.#attachment = attachment;
    void this.reconcile().catch(() => {});
  }
  reconcile(): Promise<void> {
    const attachment = this.#attachment;
    const generation = this.#generation;
    return this.#run(async () => {
      const native = this.native;
      if (
        !native ||
        native.notificationPreviewVersion !== 1 ||
        !attachment ||
        !attachment.current() ||
        !attachment.capabilities.includes("notification-preview-v1") ||
        this.#accountBlocked ||
        this.#blocked.has(attachment.deploymentId) ||
        this.push.getSnapshot().status !== "registered"
      )
        return;
      const current = () =>
        !this.#accountBlocked &&
        generation === this.#generation &&
        attachment.current() &&
        !this.#blocked.has(attachment.deploymentId);
      const accountId = await this.subject();
      if (
        !accountId ||
        !current() ||
        (await this.push.registeredAccountSubject()) !== accountId ||
        !current()
      )
        return;
      const installationId = await this.push.installationId();
      if (!current()) return;
      if (this.#rotationRequired.has(attachment.deploymentId)) {
        await native.erase(attachment.deploymentId);
        this.#rotationRequired.delete(attachment.deploymentId);
        if (!current()) return;
      }
      const key = await native.key(attachment.deploymentId);
      if (!current()) return;
      await attachment.dispatch({
        type: "notification.preview.register",
        installationId,
        accountId,
        keyId: key.keyId,
        key: key.key,
      });
    }).catch(() => this.push.previewFailed());
  }
  /** Fences immediately; local erasure precedes any remote work, even offline. */
  clear(deploymentId: string | null, unregister = true): Promise<void> {
    this.#generation += 1;
    const attachment = this.#attachment;
    if (deploymentId) this.#blocked.add(deploymentId);
    else this.#accountBlocked = true;
    return this.#run(async () => {
      const native = this.native;
      if (!native || native.notificationPreviewVersion !== 1) return;
      const deployments =
        deploymentId === null ? await native.deployments().catch(() => []) : [deploymentId];
      const existing = await Promise.all(
        deployments.map(async (id) => ({ id, key: await native.existing(id).catch(() => null) })),
      );
      for (const id of deployments) this.#rotationRequired.add(id);
      await native
        .erase(deploymentId)
        .then(() => {
          for (const id of deployments) this.#rotationRequired.delete(id);
        })
        .catch(() => {});
      if (!unregister) return;
      const installationId = await this.push.installationId().catch(() => null);
      if (installationId === null) return;
      for (const { id, key } of existing) {
        if (!key) continue;
        const command: PreviewCommand = {
          type: "notification.preview.unregister",
          installationId,
          keyId: key.keyId,
        };
        if (this.unregister) await this.unregister(id, command).catch(() => {});
        else if (attachment?.deploymentId === id && attachment.current())
          await attachment.dispatch(command).catch(() => {});
      }
    });
  }
  accountSignedIn(): void {
    this.#accountBlocked = false;
  }
  signedIn(deploymentId: string): void {
    this.#accountBlocked = false;
    this.#blocked.delete(deploymentId);
  }
  #run(work: () => Promise<void>): Promise<void> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => {});
    return result;
  }
}
