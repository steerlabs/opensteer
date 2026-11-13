import { useContext, useState, type ReactNode } from "react";
import type { Request } from "@opensteer/core";
import { turnOnDeviceAccess } from "@opensteer/client/computers";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { actionErrorMessage } from "../ui-utils.js";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import { useHereId } from "./computers/here.js";
import { Icon } from "./icon.js";
import { capabilityLabel, type DeviceCapability } from "./devices/device-access.js";
import {
  MacosPermissionRows,
  missingMacosGrant,
  readMacosGrants,
  useMacosGrants,
} from "./devices/macos-permission-rows.js";
import { SetupList } from "./first-run/setup-list.js";
import {
  DeviceGrantDock,
  DeviceGrantFollowUpContext,
  type DeviceGrantFollowUp,
} from "./workspace/device-grant-follow-ups.js";

export { turnOnDeviceAccess } from "@opensteer/client/computers";

export function deviceAccessRequestTitle(payload: {
  readonly access: DeviceCapability;
  readonly machineName: string;
}): string {
  return `Let your agent use ${capabilityLabel[payload.access]} on ${payload.machineName}?`;
}

/**
 * The follow-ups a surface shows: those pressed in this conversation's dock
 * whose Request is no longer on it, narrowed to one subagent in its own view.
 */
export function useDeviceGrantFollowUps(scope: {
  readonly threadId: string;
  readonly nodeId?: string | undefined;
  readonly liveRequestIds?: readonly string[];
}): ReactNode {
  const store = useContext(DeviceGrantFollowUpContext);
  const { deploymentId } = useShell().snapshot;
  const shown = (store?.followUps ?? []).filter(
    (entry) =>
      entry.deploymentId === deploymentId &&
      entry.threadId === scope.threadId &&
      (scope.nodeId === undefined || entry.nodeId === scope.nodeId) &&
      !scope.liveRequestIds?.includes(entry.requestId),
  );
  if (!store || shown.length === 0) return null;
  return shown.map((followUp) => (
    <DeviceGrantFollowUpCard
      followUp={followUp}
      key={followUp.requestId}
      onDone={() => store.release(followUp.requestId)}
    />
  ));
}

function DeviceGrantFollowUpCard({
  followUp,
  onDone,
}: {
  readonly followUp: DeviceGrantFollowUp;
  readonly onDone: () => void;
}) {
  const { desktopBridge } = useShell();
  const { grants, reload } = useMacosGrants(desktopBridge);
  if (!desktopBridge) return null;
  const label = capabilityLabel[followUp.access];
  const missing = grants === null || missingMacosGrant(grants, followUp.access);
  return (
    <div className="input-surface input-surface--action request-card">
      <section aria-label={`${label} on ${followUp.machineName}`} className="action-panel">
        <div className="action-panel__head">
          <span aria-hidden className="action-panel__icon">
            <Icon name={missing ? "lock" : "check"} />
          </span>
          <span className="action-panel__title">{`${label} is on for ${followUp.machineName}`}</span>
        </div>
        <div className="action-panel__content">
          <ActionNote>
            {missing ? "macOS still has to allow it here." : "macOS allows it now."}
          </ActionNote>
          <SetupList label="macOS permissions">
            <MacosPermissionRows
              apps={followUp.access === "apps"}
              bridge={desktopBridge}
              files={followUp.access === "files"}
              grants={grants}
              onAsked={reload}
            />
          </SetupList>
          <div className="action-buttons">
            <button className="btn" onClick={onDone} type="button">
              {missing ? "Do this later" : "Done"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * An agent asking for a capability that is off on one device. "Turn it on"
 * flips the switch; where this window is that Mac, any macOS grant it still
 * needs follows where it was pressed, after the Request itself has resolved. "Not now"
 * sticks for this task.
 */
export function ThreadDeviceAccessAction({
  disabled = false,
  request,
}: {
  readonly disabled?: boolean;
  readonly request: Request;
}) {
  const { desktopBridge, hostClient, reportActionError, snapshot } = useShell();
  const followUps = useContext(DeviceGrantFollowUpContext);
  const dockThreadId = useContext(DeviceGrantDock);
  const hereId = useHereId();
  const [pending, setPending] = useState<"on" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const payload = request.payload.kind === "device.access" ? request.payload : null;
  const onThisMac = payload !== null && desktopBridge !== null && hereId === payload.machineId;
  if (!payload) return <ActionNote alert>This device request is invalid.</ActionNote>;
  const { access, machineId, machineName } = payload;

  async function turnOn() {
    if (pending || disabled) return;
    setPending("on");
    setError(null);
    let followUp = false;
    try {
      // Retained before the write: fulfilling resolves this Request and unmounts it.
      followUp =
        onThisMac && desktopBridge !== null
          ? missingMacosGrant(await readMacosGrants(desktopBridge), access)
          : false;
      if (followUp)
        followUps?.retain({
          access,
          deploymentId: snapshot.deploymentId,
          machineId,
          machineName,
          nodeId: request.originatingNodeId ?? null,
          requestId: request.id,
          threadId: dockThreadId ?? request.originatingThreadId,
        });
      await turnOnDeviceAccess(hostClient, machineId, access);
    } catch (reason) {
      if (followUp) followUps?.release(request.id);
      setError(actionErrorMessage(reason));
    } finally {
      setPending(null);
    }
  }

  async function decline() {
    if (pending || disabled) return;
    setPending("decline");
    setError(null);
    try {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
        requestId: request.id,
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      });
    } catch (reason) {
      setError(actionErrorMessage(reason));
      reportActionError(reason);
      setPending(null);
    }
  }

  return (
    <>
      <ActionNote>
        Turning it on may still need an app, browser profile or macOS permission.
      </ActionNote>
      {error ? <ActionNote alert>{error}</ActionNote> : null}
      <div className="action-buttons">
        <button
          className="btn"
          disabled={pending !== null || disabled}
          onClick={() => void decline()}
          type="button"
        >
          Not now
        </button>
        <button
          className="btn btn--primary"
          disabled={pending !== null || disabled}
          onClick={() => void turnOn()}
          type="button"
        >
          {pending === "on" ? "Turning on…" : "Turn it on"}
        </button>
      </div>
    </>
  );
}
