import type {
  HostClient,
  NativeViewerSource,
  WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { ComputerDisplay, ComputerOwnerView, ComputerTaskView } from "./phone-display.js";

/**
 * An app or phone in front of the reader, read with exactly the authority its
 * route names: a task's own session, or the person's own view by its exact
 * generation. Neither ever stands in for the other.
 */
export function MacAppView(props: {
  readonly active: boolean;
  readonly destination: Exclude<WorkspaceSurfaceDestination, { kind: "browser" }>;
  readonly hostClient: HostClient;
}): ReactNode {
  const { destination } = props;
  const appKey = destination.kind === "app" ? destination.appKey : null;
  if (destination.source?.kind === "owner-view")
    return (
      <ComputerOwnerView
        active={props.active}
        appKey={appKey}
        generation={destination.source.generation}
        hostClient={props.hostClient}
        machineId={destination.machineId}
        viewId={destination.source.viewId}
      />
    );
  return destination.computerSessionId === undefined ? null : (
    <ComputerTaskView
      active={props.active}
      appKey={appKey}
      computerSessionId={destination.computerSessionId}
      hostClient={props.hostClient}
      machineId={destination.machineId}
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
