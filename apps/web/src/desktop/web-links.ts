import {
  DesktopWebLinkSchema,
  DesktopWebLinkRequestSchema,
  type DesktopWebLink,
  type DesktopWebLinkDelivery,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import type {
  BrowserIdentityChoice,
  HostClient,
  HostSnapshot,
  WorkspaceSurfaceDestination,
} from "@opensteer/client/host";

/** Uses the same person-owned command as the start page, with a replay-safe key. */
export async function openDesktopWebLink(
  value: unknown,
  client: HostClient,
  identity: BrowserIdentityChoice,
  show: (destination: WorkspaceSurfaceDestination) => void,
  acknowledge: (id: string) => Promise<void>,
): Promise<void> {
  const link = DesktopWebLinkSchema.parse(value);
  const opened = await client.openBrowserTab(
    { identity },
    { url: link.url, idempotencyKey: `desktop-web-link:${link.id}` },
  );
  show({ kind: "browser", sessionId: opened.sessionId, tabId: opened.tabId });
  await acknowledge(link.id);
}

export interface WebLinkFailureActions {
  readonly retry: () => Promise<void>;
  readonly dismiss: () => Promise<void>;
}
type OpenDelivery = (
  link: DesktopWebLink,
  acknowledge: (id: string) => Promise<void>,
) => Promise<void>;

export function receiveDesktopWebLinks(
  bridge: OpensteerDesktopBridge,
  scope: {
    deploymentId: DesktopWebLinkDelivery["deploymentId"];
    userId: DesktopWebLinkDelivery["userId"];
    identity: () => BrowserIdentityChoice;
  },
  start: () => OpenDelivery,
  error: (error: unknown, actions?: WebLinkFailureActions) => void,
): () => void {
  const generation = crypto.randomUUID();
  let active = true;
  const inFlight = new Set<string>();
  const delivery = (input: Partial<DesktopWebLinkDelivery>) =>
    bridge.webLinkDelivery!({
      deploymentId: scope.deploymentId,
      userId: scope.userId,
      generation,
      ready: true,
      ...input,
    });
  const unsubscribe = bridge.onWorkspaceTabCommand((command) => {
    if (
      !active ||
      command.type !== "open-web-url" ||
      command.generation !== generation ||
      inFlight.has(command.id)
    )
      return;
    const open = start();
    let bound: DesktopWebLink | null = null;
    let busy = false;
    let done = false;
    const attempt = async () => {
      if (!active || busy || done) return;
      busy = true;
      inFlight.add(command.id);
      try {
        bound ??= await delivery({
          bind: {
            id: command.id,
            identity:
              command.request?.identity ??
              DesktopWebLinkRequestSchema.shape.identity.parse(scope.identity()),
          },
        });
        if (!active) return;
        const request = bound?.request;
        if (
          !bound ||
          !request ||
          request.deploymentId !== scope.deploymentId ||
          request.userId !== scope.userId
        )
          throw new Error(
            "This web link belongs to another signed-in Personal session. Return to that session or dismiss the link.",
          );
        await open(bound, async (id) => {
          if (active) await delivery({ acknowledgedId: id });
        });
        done = true;
      } catch (reason) {
        if (active) error(reason, actions);
      } finally {
        busy = false;
        inFlight.delete(command.id);
      }
    };
    const actions: WebLinkFailureActions = {
      retry: attempt,
      dismiss: async () => {
        if (!active || busy || done) return;
        busy = true;
        try {
          await delivery({ dismissedId: command.id });
          done = true;
        } catch (reason) {
          if (active) error(reason, actions);
        } finally {
          busy = false;
        }
      },
    };
    void attempt();
  });
  void delivery({}).catch((reason) => {
    if (active) error(reason);
  });
  return () => {
    active = false;
    unsubscribe();
    void delivery({ ready: false }).catch(() => undefined);
  };
}

export function desktopWebLinksReady(personal: boolean, snapshot: HostSnapshot): boolean {
  return (
    personal &&
    snapshot.connection === "connected" &&
    snapshot.user !== null &&
    snapshot.browserPlacements.some((placement) => placement.available)
  );
}

export interface WebLinkView {
  readonly revision: number;
  /** Wall-clock time of the change that produced this revision. */
  readonly changedAt: number;
}

/**
 * Selects each link's tab unless the person chose another view after it
 * arrived. Main hands over one waiting link at a time, so a choice seen while
 * one link opened also covers the links that were already waiting behind it.
 */
export function webLinkSelection(
  view: () => WebLinkView,
): (
  show: (destination: WorkspaceSurfaceDestination) => void,
) => (receivedAt: number | undefined) => (destination: WorkspaceSurfaceDestination) => void {
  let leftAt = Number.NEGATIVE_INFINITY;
  return (show) => {
    const arrival = view().revision;
    return (receivedAt) => (destination) => {
      const current = view();
      if (current.revision !== arrival) leftAt = Math.max(leftAt, current.changedAt);
      else if (receivedAt === undefined || receivedAt >= leftAt) show(destination);
    };
  };
}
