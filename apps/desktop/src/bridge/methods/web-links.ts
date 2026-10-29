import type { WebContents } from "electron";
import type { DesktopWebLink, DesktopWebLinkDelivery } from "@opensteer/protocol/desktop";
import type { DesktopWebLinks } from "../../app/web-links.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";

/** A connected Personal attachment is authenticated to its Host, including local owner access. */
export function personalWebLinksAvailable(
  snapshot: DeploymentAccessSnapshot,
  deploymentId: string,
): boolean {
  const selected = snapshot.deployments.find((d) => d.id === snapshot.selectedDeploymentId);
  return (
    selected?.id === deploymentId && selected.kind === "personal" && selected.status === "connected"
  );
}

type DeliverySender = Pick<WebContents, "send" | "once" | "removeListener" | "isDestroyed">;

/** One workspace window owns each delivery generation; panels never participate. */
export class WebLinkDeliveryOwner {
  #owner: {
    sender: DeliverySender;
    deploymentId: string;
    userId: string;
    generation: string;
    detach: () => void;
  } | null = null;
  readonly #retired = new Set<string>();
  readonly links: DesktopWebLinks;
  readonly isWorkspace: (sender: DeliverySender) => boolean;
  readonly available: (deploymentId: string) => boolean;
  constructor(
    links: DesktopWebLinks,
    isWorkspace: (sender: DeliverySender) => boolean,
    available: (deploymentId: string) => boolean,
  ) {
    this.links = links;
    this.isWorkspace = isWorkspace;
    this.available = available;
  }
  handle(sender: DeliverySender, input: DesktopWebLinkDelivery): DesktopWebLink | null {
    if (!this.isWorkspace(sender))
      throw new Error("Only the workspace window may receive web links.");
    const owner = this.#owner;
    const matches =
      owner?.sender === sender &&
      owner.deploymentId === input.deploymentId &&
      owner.userId === input.userId &&
      owner.generation === input.generation;
    if (owner?.generation === input.generation && !matches) return null;
    if (!input.ready) {
      if (matches) this.dispose();
      return null;
    }
    if (!this.available(input.deploymentId)) return null;
    if (input.acknowledgedId || input.dismissedId || input.bind) {
      if (!matches) return null;
      if (input.bind)
        return this.links.bind(input.bind.id, {
          deploymentId: input.deploymentId,
          userId: input.userId,
          identity: input.bind.identity,
        });
      this.links.acknowledge(input.acknowledgedId ?? input.dismissedId!);
      return null;
    }
    if (this.#retired.has(input.generation)) return null;
    if (matches) return null;
    this.dispose();
    let detachConsumer = () => {};
    const cleanup = () => {
      if (this.#owner?.generation === input.generation && this.#owner.sender === sender)
        this.dispose();
    };
    this.#owner = {
      sender,
      deploymentId: input.deploymentId,
      userId: input.userId,
      generation: input.generation,
      detach: () => {
        detachConsumer();
        sender.removeListener("did-start-loading", cleanup);
        sender.removeListener("destroyed", cleanup);
      },
    };
    detachConsumer = this.links.attach((link) => {
      if (!sender.isDestroyed() && this.available(input.deploymentId))
        sender.send(desktopBridgeChannels.workspaceTabCommand, {
          ...link,
          generation: input.generation,
        });
    });
    sender.once("did-start-loading", cleanup);
    sender.once("destroyed", cleanup);
    return null;
  }
  dispose(): void {
    if (!this.#owner) return;
    this.#retired.add(this.#owner.generation);
    this.#owner.detach();
    this.#owner = null;
  }
}
