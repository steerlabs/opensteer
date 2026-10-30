import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  HostClientRequestError,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { computerAppIdentityKey, type ComputerView } from "@opensteer/protocol";
import { actionErrorMessage, usePageVisible } from "../../ui-utils.js";
import { AppMark } from "../computer-apps/computer-use-section.js";
import { ComputerDisplayScreen, PhoneControlBar, useComputerDisplay } from "../phone-display.js";
import {
  canStreamComputerDisplay,
  computerReasonWords,
  ownerViewComputerReadiness,
} from "@opensteer/client/integrations";
import { Icon } from "../icon.js";
import { SurfaceMenu, type SurfaceMenuItem } from "../surface-menu.js";
import { useToast, useToastToolbar } from "../toast.js";
import { ownerViewDestination, ownerViewReadiness } from "./owner-views.js";
import { useTabCloser } from "./tab-closer.js";
import { useWorkspace } from "./workspace-context.js";

type OwnerDestination = Extract<WorkspaceSurfaceDestination, { kind: "app" | "phone" }>;

const renewSoonMs = 90_000;

/**
 * The person's independent view: a phone display or negotiated Mac app control.
 * Visible retainers renew its authority independently of tasks and transport
 * recovery. Closing it ends this generation without closing the app or task.
 */
export function OwnerView({
  destination,
  marks,
  hostClient,
  hostConnected,
  leading,
  place,
  trailing,
}: {
  readonly destination: OwnerDestination;
  readonly marks: ReactNode;
  readonly hostClient: HostClient;
  readonly hostConnected: boolean;
  readonly leading: ReactNode;
  readonly place: PlaceItem | null;
  readonly trailing: ReactNode;
}) {
  const visible = usePageVisible();
  const source = destination.source?.kind === "owner-view" ? destination.source : null;
  const viewId = source?.viewId ?? "";
  const generation = source?.generation ?? 0;
  const { localMachine, nav } = useWorkspace();
  const toast = useToast();
  const toolbarRef = useToastToolbar();
  const requestClose = useTabCloser();
  const select = useCallback(
    (snapshot: HostSnapshot) => {
      const machine = snapshot.machines.find((candidate) => candidate.id === destination.machineId);
      return {
        machine: machine ?? null,
        view: machine?.computerUse?.ownerViews?.find((view) => view.viewId === viewId) ?? null,
      };
    },
    [destination.machineId, viewId],
  );
  const { machine, view } = useHostSelector(hostClient, select, sameOwnerView);
  const current = view && view.generation === generation ? view : null;
  const phone = destination.kind === "phone";
  const appIdentity =
    current?.target.kind === "app"
      ? current.target.app
      : place?.icon.kind === "app"
        ? place.icon.app
        : null;
  const machineName = machine?.name ?? (phone ? "Your phone" : "Your Mac");
  const targetName = phone
    ? machineName
    : [appIdentity?.displayName ?? "This app", current?.window?.title ?? view?.window?.title]
        .filter(Boolean)
        .join(" — ");
  const readiness = ownerViewReadiness(machine, current, phone);
  const live = readiness === null && machine !== null && canStreamComputerDisplay(machine);
  const display = useComputerDisplay({
    macWindow: !phone,
    // Hiding the page pauses the picture in the client, which keeps the last one.
    enabled: live,
    disabledReason: "unavailable",
    hostClient,
    source,
    streamable: machine !== null && canStreamComputerDisplay(machine),
  });

  // Kept alive only while on screen here: a hidden or unmounted viewer stops
  // renewing and leaves the view to expire when nobody anywhere looks. Shown
  // again close to its expiry, it renews at once rather than lapse in sight.
  const alive = current !== null && current.state === "ready";
  const owned = source !== null;
  // Read when shown, not followed: a renewal's later expiry starts no other retention.
  const expiresAt = useRef<string | null>(null);
  expiresAt.current = current?.expiresAt ?? null;
  useEffect(() => {
    if (!alive || !owned || !visible) return;
    const held = hostClient.retainComputerView(viewId, generation);
    const expiry = expiresAt.current;
    if (expiry !== null && Date.parse(expiry) - Date.now() < renewSoonMs)
      void hostClient.renewComputerView(viewId, generation).catch(() => undefined);
    return () => held.release();
  }, [alive, generation, hostClient, owned, viewId, visible]);

  const shown = live ? display.picture : null;
  const canControl = !phone && display.snapshot.input === "available";
  const inputAvailable = canControl && display.snapshot.input === "available";
  useEffect(() => {
    if (!visible) display.lease?.resetInput();
  }, [visible, display.lease]);

  const [zoomed, setZoomed] = useState(false);
  const [reopening, setReopening] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reopen = async () => {
    // Fenced at the press: a place chosen while this waits keeps the middle.
    const show = nav.beginPlaceOperation({ replace: true });
    setReopening(true);
    try {
      const target =
        current?.target ??
        (await (async () => {
          const apps = await hostClient.listApprovedComputerApps();
          return (
            apps.find(
              (app) =>
                app.machineId === destination.machineId &&
                (destination.kind === "phone"
                  ? app.target.kind === "phone"
                  : app.target.kind === "app" &&
                    computerAppIdentityKey(app.target.app) === destination.appKey),
            )?.target ?? null
          );
        })());
      if (!target) throw new Error(`${targetName} is no longer approved for viewing.`);
      const boundTarget =
        target.kind === "app" && destination.kind === "app" && destination.windowId !== undefined
          ? { ...target, window: destination.windowId }
          : target;
      const opened = await hostClient.openComputerView(destination.machineId, boundTarget);
      if (mounted.current) {
        show(ownerViewDestination(opened));
      }
    } catch (error) {
      toast.error(
        error instanceof HostClientRequestError && error.reason
          ? computerReasonWords(error.reason, { machine: machineName, phone, target: targetName })
          : actionErrorMessage(error),
      );
    } finally {
      if (mounted.current) setReopening(false);
    }
  };

  const local =
    !phone &&
    localMachine?.useApp != null &&
    localMachine.machineId === destination.machineId &&
    readiness === null &&
    appIdentity !== null;
  const useHere = async () => {
    if (!local || !appIdentity || !localMachine?.useApp || !current) return;
    try {
      const result = await localMachine.useApp(
        { viewId: current.viewId, generation: current.generation },
        appIdentity,
      );
      if (!result.activated) {
        const words = {
          "deployment-changed": "Select this app’s place and try again.",
          "not-local": "This app isn’t on this Mac.",
          "view-ended": "This view has ended. Open the app’s view again.",
          "app-changed": `${targetName} is no longer available on this Mac.`,
          "permission-required": "Allow computer use on this Mac and try again.",
          unavailable: `${targetName} couldn’t be brought forward. Try again.`,
        };
        toast.error(words[result.reason]);
      }
    } catch {
      toast.error(`${targetName} couldn’t be brought forward. Try again.`);
    }
  };

  const held = (place?.occupants.length ?? 0) > 0;
  const menu: SurfaceMenuItem[] = [
    ...(shown
      ? [
          {
            icon: zoomed ? ("fit" as const) : ("expand" as const),
            label: zoomed ? "Fit to window" : "Actual size",
            onSelect: () => setZoomed((value) => !value),
          },
        ]
      : []),
    ...(place?.ownerClose
      ? [
          {
            detail: held ? "The task keeps working" : `${targetName} stays open`,
            icon: "close" as const,
            label: "Close view",
            onSelect: () => requestClose(place),
          },
        ]
      : []),
  ];

  const reopenEligible = hostConnected && ownerViewComputerReadiness(machine, phone) === null;
  const state: { readonly words: string; readonly busy: boolean; readonly reopen: boolean } | null =
    readiness !== null
      ? {
          busy: readiness === "opening" || readiness === "connecting",
          reopen:
            reopenEligible &&
            (current === null || (current.state !== "ready" && current.state !== "opening")),
          words:
            current === null && view !== null
              ? "This view was replaced."
              : readiness === "opening"
                ? `Opening ${targetName}…`
                : computerReasonWords(readiness, {
                    machine: machineName,
                    phone,
                    target: targetName,
                  }),
        }
      : display.reason
        ? {
            busy: display.retrying,
            reopen: !phone && display.snapshot.connection === "closed",
            words: computerReasonWords(display.reason, {
              machine: machineName,
              phone,
              target: targetName,
            }),
          }
        : shown
          ? null
          : {
              busy: true,
              reopen: false,
              words: phone ? `Connecting to ${machineName}…` : display.startingWords,
            };

  return (
    <section
      aria-label={`${targetName}${phone ? "" : ` on ${machineName}`}`}
      className="owner-view"
    >
      <header className="computer-watch__bar surface-row owner-view__bar" ref={toolbarRef}>
        {leading}
        <span className="computer-watch__source">
          {appIdentity ? (
            <AppMark identity={appIdentity} machineId={destination.machineId} />
          ) : (
            <span aria-hidden className="computer-watch__glyph">
              <Icon name="phone" />
            </span>
          )}
          <span className="computer-watch__app">{targetName}</span>
          {phone ? null : <span className="computer-watch__place">{machineName}</span>}
        </span>
        {!canControl ? (
          <span className="owner-view__view-only" title="You can watch it here, not use it">
            <Icon name="eye" />
            View only
          </span>
        ) : null}
        {marks}
        <span className="computer-watch__spacer" />
        {local ? (
          <button className="btn owner-view__use" onClick={() => void useHere()} type="button">
            <Icon name="external-link" />
            Use on this Mac
          </button>
        ) : null}
        {menu.length > 0 ? (
          <SurfaceMenu items={menu} label={phone ? "Phone options" : "App options"} />
        ) : null}
        {trailing}
      </header>
      <div
        className={zoomed && shown ? "owner-view__stage is-zoomed" : "owner-view__stage"}
        onKeyDown={(event) => {
          if (event.key === "Escape" && zoomed) {
            event.preventDefault();
            setZoomed(false);
          }
        }}
      >
        {live ? (
          <ComputerDisplayScreen
            dim={false}
            display={display}
            interactive={inputAvailable && visible}
            label={targetName}
            onEnlarge={() => setZoomed((value) => !value)}
            shown={shown !== null}
          />
        ) : null}
        {state ? (
          <div
            className={shown ? "owner-view__state owner-view__state--over" : "owner-view__state"}
            role="status"
          >
            {state.busy ? <span aria-hidden className="browser-waiting__spinner" /> : null}
            <span>{state.words}</span>
            {state.reopen ? (
              <button
                className="btn btn--small"
                disabled={reopening}
                onClick={() => void reopen()}
                type="button"
              >
                {reopening ? "Opening…" : "Open again"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {canControl ? <PhoneControlBar display={display} /> : null}
    </section>
  );
}

function sameOwnerView(
  left: { readonly machine: unknown; readonly view: ComputerView | null },
  right: { readonly machine: unknown; readonly view: ComputerView | null },
): boolean {
  return left.machine === right.machine && left.view === right.view;
}
