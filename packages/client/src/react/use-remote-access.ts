import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { IssuePersonalPairingCodeResponse } from "@opensteer/protocol";
import type { HostClient } from "../host/client.js";
import { requestPersonalRemoteAccess } from "../host/personal-remote-access.js";
import {
  RemoteAccessRunner,
  remoteAccessActionGoal,
  remoteAccessView,
  type RemoteAccessActionId,
  type RemoteAccessFacts,
  type RemoteAccessLink,
  type RemoteAccessPort,
  type RemoteAccessView,
} from "../host/remote-access.js";
import type { usePersonalRemoteAccess } from "./use-personal-remote-access.js";

export interface RemoteAccessController {
  readonly view: RemoteAccessView;
  /** Runs an action the view offered. Ask its `confirm` first, if it has one. */
  readonly act: (action: RemoteAccessActionId) => void;
  /** Stops the steps not yet sent, as closing the view does. */
  readonly stop: () => void;
  readonly pairing: IssuePersonalPairingCodeResponse | null;
}

/**
 * "Use from anywhere" for one computer. The caller passes its own remote
 * access observation, so a screen reads that status once, and the platform
 * port that signs in and links on this device.
 */
export function useRemoteAccess(input: {
  readonly hostClient: HostClient;
  readonly remote: ReturnType<typeof usePersonalRemoteAccess>;
  readonly port: RemoteAccessPort;
  readonly link: RemoteAccessLink | null;
  readonly signedIn: boolean | null;
  readonly computerName: string | null;
}): RemoteAccessController {
  const { computerName, hostClient, link, port, remote, signedIn } = input;
  const facts = useMemo<RemoteAccessFacts>(
    () => ({
      computerName,
      link,
      signedIn,
      status: remote.status,
      statusUnreadable: remote.status === null && remote.error !== null,
    }),
    [computerName, link, remote.error, remote.status, signedIn],
  );
  const hostClientRef = useRef(hostClient);
  hostClientRef.current = hostClient;
  const [runner] = useState(
    () =>
      new RemoteAccessRunner({
        facts,
        port,
        request: (intent) => requestPersonalRemoteAccess(hostClientRef.current, intent),
      }),
  );
  useEffect(() => runner.update(facts, port), [facts, port, runner]);
  useEffect(() => () => runner.stop(), [runner]);
  const run = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
  const view = useMemo(() => remoteAccessView(facts, run), [facts, run]);
  const pair = remote.pair;
  const act = useCallback(
    (action: RemoteAccessActionId) => {
      if (action === "add-device") {
        void pair?.();
        return;
      }
      const goal = remoteAccessActionGoal(action, facts, run);
      if (goal) runner.start(goal);
    },
    [facts, pair, run, runner],
  );
  const stop = useCallback(() => runner.stop(), [runner]);
  return { act, pairing: remote.pairing, stop, view };
}
