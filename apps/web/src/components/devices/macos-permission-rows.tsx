import { useCallback, useEffect, useState } from "react";
import {
  desktopComputerUseOffInTrial,
  desktopComputerUseUnsupported,
  type DesktopComputerUsePermissionsResult,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { Icon } from "../icon.js";
import { SetupRow } from "../first-run/setup-list.js";

export type MacosGrants = {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly fullDiskAccess: boolean;
  /** Why Apps cannot be allowed here at all, in the desktop's own words. */
  readonly appsOff?: string;
} | null;

/** The sentences the desktop refuses with when computer use is off here. */
const appsOffSentences: readonly string[] = [
  desktopComputerUseOffInTrial,
  desktopComputerUseUnsupported,
];

/**
 * Which of the desktop's own sentences an IPC refusal ends with: the words
 * shown are that constant, never the refusal's text.
 */
function appsOffReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return appsOffSentences.find((sentence) => error.message.endsWith(`: ${sentence}`));
}

/** Matches the desktop docs: computer use needs a build signed with a Developer ID. */
export const unsignedBuildSentence =
  "This build isn’t signed with a Developer ID, so it can’t set up computer use. See apps/desktop/README.md.";

/** Opens the desktop's Apps permission panel, and says why when it cannot. */
export async function openAppsPermissionsPanel(
  bridge: OpensteerDesktopBridge,
  say: (words: string) => void,
): Promise<void> {
  try {
    const result = await bridge.openComputerUsePermissionsPanel();
    if (!result.opened) say(unsignedBuildSentence);
  } catch (error) {
    say(
      appsOffReason(error) ??
        "System Settings didn’t open. Open System Settings › Privacy & Security › Accessibility and turn on Opensteer.",
    );
  }
}

const grantPane = {
  accessibility: "Accessibility",
  "screen-recording": "Screen Recording",
  "full-disk-access": "Full Disk Access",
} as const;

/** Grants change in System Settings, so they are read again whenever this window regains focus. */
export function useMacosGrants(bridge: OpensteerDesktopBridge | null): {
  readonly grants: MacosGrants;
  readonly reload: () => void;
} {
  const [grants, setGrants] = useState<MacosGrants>(null);
  const reload = useCallback(() => {
    if (bridge) void readMacosGrants(bridge).then(setGrants);
  }, [bridge]);
  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return { grants, reload };
}

export async function readMacosGrants(bridge: OpensteerDesktopBridge): Promise<MacosGrants> {
  let appsOff: string | undefined;
  const [apps, disk]: [DesktopComputerUsePermissionsResult | null, { granted: boolean } | null] =
    await Promise.all([
      bridge.computerUsePermissionsGet().catch((error: unknown) => {
        appsOff = appsOffReason(error);
        return null;
      }),
      bridge.checkFullDiskAccess().catch(() => null),
    ]);
  return {
    accessibility: apps?.accessibility === "granted",
    screenRecording: apps?.screenRecording === "granted",
    fullDiskAccess: disk?.granted === true,
    ...(appsOff ? { appsOff } : {}),
  };
}

export function missingMacosGrant(
  grants: MacosGrants,
  capability: "browser" | "apps" | "files",
): boolean {
  if (!grants) return false;
  if (capability === "apps") return !grants.accessibility || !grants.screenRecording;
  if (capability === "files") return !grants.fullDiskAccess;
  return false;
}

export function MacosPermissionRows({
  apps,
  bridge,
  files,
  grants,
  onAsked,
}: {
  readonly apps: boolean;
  readonly bridge: OpensteerDesktopBridge;
  readonly files: boolean;
  readonly grants: MacosGrants;
  readonly onAsked: () => void;
}) {
  // A request that fails says so on its row: pressing the button must never do nothing.
  const [failed, setFailed] = useState<keyof typeof grantPane | null>(null);
  const ask = (pane: keyof typeof grantPane, operation: () => Promise<unknown>) => {
    setFailed(null);
    void operation().then(onAsked, () => {
      setFailed(pane);
      onAsked();
    });
  };
  const failure = (pane: keyof typeof grantPane) =>
    failed === pane
      ? `System Settings didn’t open. Open System Settings › Privacy & Security › ${grantPane[pane]} and turn on Opensteer.`
      : undefined;
  const appsOff = grants?.appsOff;
  return (
    <>
      {apps ? (
        <>
          <GrantRow
            allowed={grants?.accessibility ?? null}
            detail={appsOff ?? "For Apps · lets your agent click and type"}
            failure={failure("accessibility")}
            off={appsOff !== undefined}
            onOpen={() =>
              ask("accessibility", () =>
                bridge.computerUsePermissionsRequest({ pane: "accessibility" }),
              )
            }
            title="Accessibility"
          />
          <GrantRow
            allowed={grants?.screenRecording ?? null}
            detail={appsOff ?? "For Apps · lets your agent and your phone see its windows"}
            failure={failure("screen-recording")}
            off={appsOff !== undefined}
            onOpen={() =>
              ask("screen-recording", () =>
                bridge.computerUsePermissionsRequest({ pane: "screen-recording" }),
              )
            }
            title="Screen Recording"
          />
        </>
      ) : null}
      {files ? (
        <GrantRow
          allowed={grants?.fullDiskAccess ?? null}
          detail="For Files and commands · reach folders like Documents and Desktop"
          failure={failure("full-disk-access")}
          off={false}
          onOpen={() => ask("full-disk-access", () => bridge.requestFullDiskAccess())}
          title="Full Disk Access"
        />
      ) : null}
    </>
  );
}

function GrantRow({
  allowed,
  detail,
  failure,
  off,
  onOpen,
  title,
}: {
  readonly allowed: boolean | null;
  readonly detail: string;
  readonly failure: string | undefined;
  /** Nothing here can grant it, so there is no button to press. */
  readonly off: boolean;
  readonly onOpen: () => void;
  readonly title: string;
}) {
  return (
    <SetupRow
      detail={
        failure ? (
          <>
            {detail}
            <span className="setup-row__failure" role="alert">
              {" "}
              {failure}
            </span>
          </>
        ) : (
          detail
        )
      }
      title={title}
      tone={allowed ? "ready" : off ? "missing" : "idle"}
      trailing={
        off ? null : allowed === null ? (
          <span aria-label="Checking" className="spinner" role="status" />
        ) : allowed ? (
          <span className="setup-done">
            <Icon name="check" />
            Allowed
          </span>
        ) : (
          <button className="btn btn--small" onClick={onOpen} type="button">
            Open System Settings
          </button>
        )
      }
    />
  );
}
