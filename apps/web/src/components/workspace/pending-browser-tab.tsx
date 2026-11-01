import { memo, useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { BrowserTabOpenInput, HostClient, PendingBrowserTab } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { Icon } from "../icon.js";
import { useWorkspace } from "./workspace-context.js";
import { startPageLink } from "./navigation.js";

export const PendingBrowserTabView = memo(function PendingBrowserTabView(props: {
  readonly hostClient: HostClient;
  readonly idempotencyKey: string;
  readonly leading: ReactNode;
  readonly trailing: ReactNode;
}) {
  const { hostClient, idempotencyKey } = props;
  const { nav } = useWorkspace();
  const { state } = useLocation();
  const address = startPageLink(state)?.address;
  const pending = useHostSelector(hostClient, (snapshot) =>
    snapshot.pendingBrowserTabs?.find((row) => row.idempotencyKey === idempotencyKey),
  );
  const missingOnArrival = useRef(!pending);
  const placements = useHostSelector(hostClient, (snapshot) => snapshot.browserPlacements);
  useEffect(() => {
    if (missingOnArrival.current && !pending && address)
      nav.showLauncher({ replace: true, address, open: false });
  }, [pending, address, nav]);
  const retry = (target?: BrowserTabOpenInput) => {
    if (!pending || pending.state === "opening") return;
    const opening = hostClient.beginBrowserTabOpen(target ?? pending.target, {
      ...(pending.url === undefined ? {} : { url: pending.url }),
      ...(pending.typed === undefined ? {} : { typed: pending.typed }),
      ...(pending.viewport ? { viewport: pending.viewport } : {}),
      ...(pending.state === "unknown" ? { idempotencyKey } : {}),
    });
    if (opening.idempotencyKey !== idempotencyKey)
      hostClient.dismissPendingBrowserTab(idempotencyKey);
    nav.showPendingBrowserTab(opening.idempotencyKey, {
      replace: true,
      ...(pending.url === undefined ? {} : { address: pending.url }),
    });
    void opening.result.then(
      (opened) =>
        nav.replacePendingBrowserTab(opening.idempotencyKey, {
          kind: "browser",
          sessionId: opened.sessionId,
          tabId: opened.tabId,
        }),
      () => undefined,
    );
  };
  const title =
    pending?.state === "unknown"
      ? "Opening status unknown"
      : pending?.state === "failed"
        ? pending.error?.code === "browser-placement-ambiguous"
          ? "Which computer should this tab open on?"
          : "Couldn’t open this tab"
        : pending
          ? "Opening…"
          : "This opening is no longer available";
  return (
    <section
      className="place place--browser"
      data-place-key={`pending:${idempotencyKey}`}
      aria-label={title}
    >
      <div className="browser-view">
        <div className="browser-toolbar surface-row">
          {props.leading}
          <span className="browser-address">{pending?.url ?? "New tab"}</span>
          <span className="launcher__spacer" />
          <button
            type="button"
            aria-label="Close opening tab"
            onClick={() => {
              hostClient.dismissPendingBrowserTab(idempotencyKey);
              nav.showLauncher({ replace: true });
            }}
          >
            <Icon name="close" />
          </button>
          {props.trailing}
        </div>
        <div className="browser-stage">
          <div
            className="place-state"
            role={pending?.state === "failed" ? "alert" : "status"}
            aria-busy={pending?.state === "opening"}
          >
            <p className="place-state__title">{title}</p>
            {pending?.error ? (
              <p>
                {pending.state === "unknown"
                  ? "The Host may have opened this tab. Check again to recover the same opening."
                  : pending.error.message}
              </p>
            ) : null}
            {pending && pending.state !== "opening" ? (
              <button className="btn" type="button" onClick={() => retry()}>
                {pending.state === "unknown" ? "Check again" : "Retry"}
              </button>
            ) : null}
            {pending?.state === "failed" &&
            pending.error?.code === "browser-placement-ambiguous" &&
            "identity" in pending.target
              ? placements
                  .filter((placement) => placement.available)
                  .map((placement) => (
                    <button
                      className="btn"
                      type="button"
                      key={placement.runnerId}
                      onClick={() => {
                        if ("identity" in pending.target)
                          retry({
                            ...pending.target,
                            placement: { kind: "runner", runnerId: placement.runnerId },
                          });
                      }}
                    >
                      Open on {placement.label}
                    </button>
                  ))
              : null}
          </div>
        </div>
      </div>
    </section>
  );
});

export function PendingBrowserTabRows({
  hostClient,
  onOpen,
}: {
  readonly hostClient: HostClient;
  readonly onOpen: () => void;
}) {
  const rows = useHostSelector(hostClient, (snapshot) => snapshot.pendingBrowserTabs);
  return rows?.map((pending) => (
    <PendingRow
      key={pending.idempotencyKey}
      hostClient={hostClient}
      pending={pending}
      onOpen={onOpen}
    />
  ));
}

const PendingRow = memo(function PendingRow({
  hostClient,
  pending,
  onOpen,
}: {
  readonly hostClient: HostClient;
  readonly pending: PendingBrowserTab;
  readonly onOpen: () => void;
}) {
  const { nav, selection } = useWorkspace();
  const active =
    selection.kind === "pending" && selection.idempotencyKey === pending.idempotencyKey;
  return (
    <li
      className={`side-tab${active ? " is-active" : ""}`}
      data-place-key={`pending:${pending.idempotencyKey}`}
      data-motion-key={`pending:${pending.idempotencyKey}`}
    >
      <button
        className="side-tab__main"
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => {
          onOpen();
          nav.showPendingBrowserTab(
            pending.idempotencyKey,
            pending.url === undefined ? undefined : { address: pending.url },
          );
        }}
      >
        <Icon name="globe" />
        <span className="side-tab__title">{pending.url ?? "New tab"}</span>
      </button>
      <button
        className="side-row-action side-tab__close"
        type="button"
        aria-label={`Close ${pending.url ?? "opening tab"}`}
        onClick={() => {
          hostClient.dismissPendingBrowserTab(pending.idempotencyKey);
          if (active) nav.showLauncher({ replace: true });
        }}
      >
        <Icon name="close" />
      </button>
    </li>
  );
});
