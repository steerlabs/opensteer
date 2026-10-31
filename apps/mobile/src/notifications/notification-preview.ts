import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import type { DeploymentId } from "@opensteer/core";
import type { HostCapability } from "@opensteer/deployment-authority";
import type { HostApiCommand } from "@opensteer/protocol";
import type { NotificationPreviewNative } from "../../modules/notification-preview/types.js";
import type { PushRegistration } from "./push-registration.js";

export interface PreviewAttachment {
  readonly deploymentId: DeploymentId;
  readonly capabilities: readonly HostCapability[];
  readonly current: () => boolean;
  readonly dispatch: (
    command: Extract<HostApiCommand, { type: "notification.preview.register" }>,
  ) => Promise<unknown>;
}
export class NotificationPreviews {
  #attachment: PreviewAttachment | null = null;
  // Serialize key lookup and erasure so sign-out cannot leave a late-created key.
  #queue: Promise<void> = Promise.resolve();
  readonly native: NotificationPreviewNative | null;
  readonly push: PushRegistration;
  readonly subject: () => Promise<string | null>;
  constructor(
    native: NotificationPreviewNative | null,
    push: PushRegistration,
    subject: () => Promise<string | null>,
  ) {
    this.native = native;
    this.push = push;
    this.subject = subject;
  }
  start(): Promise<void> {
    return this.#run(async () => {
      if (this.native?.notificationPreviewVersion === 1) await this.native.prepare();
    });
  }
  attach(attachment: PreviewAttachment): void {
    this.#attachment = attachment;
    void this.reconcile();
  }
  reconcile(): Promise<void> {
    const attachment = this.#attachment;
    const current = () => this.#attachment === attachment && attachment?.current();
    return (async () => {
      const native = this.native;
      if (
        !native ||
        native.notificationPreviewVersion !== 1 ||
        !attachment ||
        !current() ||
        !attachment.capabilities.includes("notification-preview-v1") ||
        this.push.getSnapshot().status !== "registered"
      )
        return;
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
      const key = await this.#run(async () =>
        current() ? native.key(attachment.deploymentId) : null,
      );
      if (!key || !current()) return;
      await attachment.dispatch({
        type: "notification.preview.register",
        installationId,
        accountId: ControlPlaneAccountIdSchema.parse(accountId),
        ...key,
      });
    })().catch(() => {});
  }
  /** Invalidate immediately; erase before the caller revokes its credentials. */
  clear(deploymentId: string | null): Promise<void> {
    if (deploymentId === null || this.#attachment?.deploymentId === deploymentId)
      this.#attachment = null;
    return this.#run(async () => {
      if (this.native?.notificationPreviewVersion === 1) await this.native.erase(deploymentId);
    }).catch(() => {});
  }
  #run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
