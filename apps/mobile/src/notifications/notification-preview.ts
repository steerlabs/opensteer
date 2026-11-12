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
/**
 * Sealed notification previews, one key per Deployment this phone hears from: the
 * personal Opensteer being shown and every team it is signed in to, so a push from
 * any of them can be read whichever computer is on screen.
 */
export class NotificationPreviews {
  readonly #attachments = new Map<DeploymentId, PreviewAttachment>();
  // Serialize key lookup and erasure so sign-out cannot leave a late-created key.
  #queue: Promise<void> = Promise.resolve();
  // Registrations land in order, so an older key cannot overwrite a newer one on the
  // Host. Clearing never waits on this chain: only reconcile joins it.
  #registrations: Promise<void> = Promise.resolve();
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
  /** Replaces this Deployment's attachment only; every other one stays registered. */
  attach(attachment: PreviewAttachment): void {
    this.#attachments.set(attachment.deploymentId, attachment);
    void this.#reconcile([attachment]);
  }
  reconcile(): Promise<void> {
    return this.#reconcile([...this.#attachments.values()]);
  }
  #reconcile(attachments: readonly PreviewAttachment[]): Promise<void> {
    for (const attachment of attachments) {
      const current = () =>
        this.#attachments.get(attachment.deploymentId) === attachment && attachment.current();
      const registration = this.#registrations.then(async () => {
        const native = this.native;
        if (
          !native ||
          native.notificationPreviewVersion !== 1 ||
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
      });
      this.#registrations = registration.catch(() => {});
    }
    return this.#registrations;
  }
  /** Invalidate immediately; erase before the caller revokes its credentials. */
  clear(deploymentId: DeploymentId | null): Promise<void> {
    if (deploymentId === null) this.#attachments.clear();
    else this.#attachments.delete(deploymentId);
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
