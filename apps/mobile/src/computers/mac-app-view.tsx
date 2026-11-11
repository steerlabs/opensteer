import type {
  HostClient,
  NativeViewerSource,
  SurfaceDestination,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import {
  ComputerDisplay,
  ComputerOwnerView,
  ComputerTaskView,
  PhoneTabView,
} from "./phone-display.js";

/**
 * An app or phone in front of the reader. An app reads with exactly the
 * authority its route names: a task's own session, or the person's own view
 * by its exact generation, and neither ever stands in for the other. A phone's
 * route names the phone, whose tab shows whichever of those is live.
 */
export function MacAppView(props: {
  readonly active: boolean;
  readonly destination: Extract<SurfaceDestination, { kind: "app" | "phone" }>;
  readonly hostClient: HostClient;
  /** The tab closed here: the page goes back. */
  readonly onClosed: () => void;
  /** The keyboard is up for the app or phone, and its pane should make room. */
  readonly onTyping: (typing: boolean) => void;
}): ReactNode {
  const { destination } = props;
  if (destination.kind === "phone")
    return (
      <PhoneTabView
        active={props.active}
        hostClient={props.hostClient}
        machineId={destination.machineId}
        onClosed={props.onClosed}
        onTyping={props.onTyping}
      />
    );
  const { appKey } = destination;
  if (destination.source?.kind === "owner-view")
    return (
      <ComputerOwnerView
        active={props.active}
        appKey={appKey}
        generation={destination.source.generation}
        hostClient={props.hostClient}
        machineId={destination.machineId}
        onTyping={props.onTyping}
        viewId={destination.source.viewId}
        windowId={destination.windowId}
      />
    );
  return destination.computerSessionId === undefined ? null : (
    <ComputerTaskView
      active={props.active}
      appKey={appKey}
      computerSessionId={destination.computerSessionId}
      hostClient={props.hostClient}
      machineId={destination.machineId}
      onTyping={props.onTyping}
    />
  );
}

/** A tile's picture of an app or phone, through the tile's own source. */
export function MacAppPreview(props: {
  readonly active: boolean;
  readonly appName: string;
  readonly hostClient: HostClient;
  readonly label: string;
  readonly machineId: string;
  readonly onPageSize?: (size: { readonly height: number; readonly width: number }) => void;
  readonly phone: boolean;
  readonly source: NativeViewerSource;
}): ReactNode {
  return (
    <ComputerDisplay
      active={props.active}
      hostClient={props.hostClient}
      source={props.source}
      phone={props.phone}
      machineId={props.machineId}
      label={props.label}
      onPageSize={props.onPageSize}
    />
  );
}
