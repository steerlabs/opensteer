import { useEffect, useState, type ReactNode } from "react";
import { DeviceIdSchema, type TabTarget } from "@opensteer/core";
import type { HostClient } from "@opensteer/client/host";
import {
  threadComputerSessions,
  type WatchableComputerSession,
} from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import { computerAppIdentityKey } from "@opensteer/integration-core/computer-app";
import type { ComputerAppIdentity, MachineSummary } from "@opensteer/protocol";
import { ComputerWatchView } from "../computer-watch.js";

/** A Mac app a task's agent holds on one of the person's computers, and which one to show. */
export interface TaskAppWatch {
  readonly watch: WatchableComputerSession;
  /** Every app the session holds, in the order the session took them. */
  readonly apps: readonly ComputerAppIdentity[];
  /** The one it used last: the last it acted in, else the last it took. */
  readonly lastUsed: string;
}

/**
 * What a task's agent is using on the person's Macs, newest session first: only an app session
 * (a phone's whole display has its own tab), only on a Mac that streams its windows, and only
 * what the Home shows this person, which is their own computers' sessions alone.
 */
export function taskAppWatch(input: {
  readonly hostConnected: boolean;
  readonly machines: readonly MachineSummary[];
  readonly threadId: string | null;
}): TaskAppWatch | null {
  const watch = threadComputerSessions(input).find(
    ({ session }) => !session.display && session.apps.length > 0,
  );
  if (!watch) return null;
  const { apps, actingAppKeys } = watch.session;
  const held = new Set(apps.map((app) => computerAppIdentityKey(app)));
  const acting = actingAppKeys.findLast((key) => held.has(key));
  return { watch, apps, lastUsed: acting ?? computerAppIdentityKey(apps.at(-1)!) };
}

/**
 * The centre of a task whose agent is using a Mac app: that app's live picture, view only, with
 * Stop, where the launcher shows otherwise. When the agent no longer holds an app there, it is the
 * launcher again. The person's own view of the same window shares the capture, and is how they
 * take over.
 */
export function TaskAppWatchPane({
  agentName,
  fallback,
  hostClient,
  hostConnected,
  leading,
  onTakeOver,
  threadId,
  trailing,
  visible,
}: {
  /** The connected agent's name, when a connected agent works this task. */
  readonly agentName: string | null;
  /** What the centre shows when nothing is being used: the launcher. */
  readonly fallback: ReactNode;
  readonly hostClient: HostClient;
  readonly hostConnected: boolean;
  readonly leading: ReactNode;
  /** Opens the person's own view of the window, as a tab of theirs. */
  readonly onTakeOver: (target: TabTarget) => void;
  readonly threadId: string | null;
  readonly trailing: ReactNode;
  readonly visible: boolean;
}) {
  const machines = useHostSelector(hostClient, (snapshot) => snapshot.machines);
  const using = taskAppWatch({ hostConnected, machines, threadId });
  const sessionId = using?.watch.session.sessionId ?? null;
  // The person's pick among the apps it holds, kept while the session holds it.
  const [picked, setPicked] = useState<{ sessionId: string; appKey: string } | null>(null);
  useEffect(() => {
    if (picked && picked.sessionId !== sessionId) setPicked(null);
  }, [picked, sessionId]);
  if (!using) return fallback;
  const { watch, apps } = using;
  const keys = apps.map((app) => computerAppIdentityKey(app));
  const appKey =
    picked?.sessionId === watch.session.sessionId && keys.includes(picked.appKey)
      ? picked.appKey
      : using.lastUsed;
  const app = apps[keys.indexOf(appKey)]!;
  const machine = watch.machine;
  const who = agentName ? `“${agentName}”` : "The agent in this task";
  const window = watch.session.windows?.find((entry) => entry.appKey === appKey);
  const computerId = DeviceIdSchema.parse(machine.id);
  const takeOver: TabTarget = window
    ? { kind: "window", computerId, windowId: window.windowId }
    : { kind: "window", computerId, bundleId: app.bundleId };
  return (
    <section aria-label={`${app.displayName} on ${machine.name}`} className="place place--watch">
      <ComputerWatchView
        app={app}
        appKey={appKey}
        hostClient={hostClient}
        hostConnected={hostConnected}
        key={`${watch.session.sessionId}:${appKey}`}
        leading={leading}
        machineId={machine.id}
        machines={machines}
        sessionId={watch.session.sessionId}
        trailing={trailing}
        visible={visible}
      />
      <div className="task-app-watch">
        <p>{`${who} is using ${app.displayName} on ${machine.name}. You are watching it.`}</p>
        {apps.length > 1 ? (
          <ul aria-label="Apps it is using" className="task-app-watch__apps">
            {apps.map((candidate, index) => (
              <li key={keys[index]}>
                <button
                  aria-pressed={keys[index] === appKey}
                  className="btn btn--small"
                  onClick={() =>
                    setPicked({ sessionId: watch.session.sessionId, appKey: keys[index]! })
                  }
                  type="button"
                >
                  {candidate.displayName}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <button className="btn btn--small" onClick={() => onTakeOver(takeOver)} type="button">
          {`Use ${app.displayName} yourself`}
        </button>
      </div>
    </section>
  );
}
