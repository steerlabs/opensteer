import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";

/**
 * Team page links the desktop opened (an invite, a channel, a message), each
 * opened here once and then acknowledged, so main stops holding it. Listening
 * starts before this window says it is ready, so a link main replays at once
 * is not missed; leaving says it is not ready, and an unacknowledged link
 * waits in main for the next window.
 */
export function receiveDesktopTeamLinks(
  bridge: Pick<OpensteerDesktopBridge, "onTeamLink" | "teamLinkDelivery">,
  open: (url: string) => void,
): () => void {
  const { onTeamLink, teamLinkDelivery } = bridge;
  if (!onTeamLink || !teamLinkDelivery) return () => undefined;
  const opened = new Set<string>();
  let active = true;
  const unsubscribe = onTeamLink.call(bridge, (link) => {
    if (!active) return;
    if (!opened.has(link.id)) {
      opened.add(link.id);
      open(link.url);
    }
    void teamLinkDelivery.call(bridge, { ready: true, acknowledgedId: link.id }).catch(() => {
      // Unacknowledged, main offers it again; it was opened once already.
    });
  });
  void teamLinkDelivery.call(bridge, { ready: true }).catch(() => undefined);
  return () => {
    active = false;
    unsubscribe();
    void teamLinkDelivery.call(bridge, { ready: false }).catch(() => undefined);
  };
}

/** Where a team page link opens in this app: the join page resolves it. */
export function teamLinkPath(url: string): string {
  return `/join?link=${encodeURIComponent(url)}`;
}
