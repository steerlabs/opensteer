import {
  asleepGateLine,
  asleepToolFailure,
  cloudSuggestionDismissed,
  cloudSuggestionShown,
  cloudSuggestionStorageKey,
  cloudSuggestionVisible,
  cloudSuggestionWords,
  cloudComputerWebsite,
  homeKind,
  parseCloudSuggestionMemory,
  type CloudSuggestionMemory,
  type HomeKind,
} from "@opensteer/client/computers";
import type { ToolEntry } from "@opensteer/client/host";
import { useCloudComputer } from "@opensteer/client/react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useShell } from "./app-shell.js";
import { useHomeKind } from "./devices/home-facts.js";
import { cloudComputerAccountFor, cloudComputerPath } from "./settings/sections/cloud-computer.js";

/** This device's memory of the Cloud Computer suggestion; storage can be missing or blocked. */
function readMemory(): CloudSuggestionMemory | null {
  try {
    return parseCloudSuggestionMemory(window.localStorage.getItem(cloudSuggestionStorageKey));
  } catch {
    return null;
  }
}
function writeMemory(memory: CloudSuggestionMemory): void {
  try {
    window.localStorage.setItem(cloudSuggestionStorageKey, JSON.stringify(memory));
  } catch {
    // Without storage it may come back sooner; it never blocks the line.
  }
}

/**
 * Whether the Cloud Computer suggestion shows for this moment, read once when the moment
 * appears, and remembered on this device the first time it does.
 */
function useCloudSuggestion(moment: string, homeKind: HomeKind | null) {
  const [visible, setVisible] = useState(() =>
    cloudSuggestionVisible({ homeKind, memory: readMemory(), moment, now: Date.now() }),
  );
  useEffect(() => {
    if (!visible) return;
    writeMemory(cloudSuggestionShown(readMemory(), moment, Date.now()));
  }, [moment, visible]);
  return {
    visible,
    dismiss: () => {
      writeMemory(cloudSuggestionDismissed(moment, Date.now()));
      setVisible(false);
    },
  };
}

function Suggestion(props: { readonly onOpen: () => void; readonly onNotNow: () => void }) {
  return (
    <span className="asleep-moment__actions">
      <button className="link-button" onClick={props.onOpen} type="button">
        {cloudSuggestionWords.link}
      </button>
      <button
        className="link-button asleep-moment__not-now"
        onClick={props.onNotNow}
        title={cloudSuggestionWords.notNowDetail}
        type="button"
      >
        {cloudSuggestionWords.notNow}
      </button>
    </span>
  );
}

/**
 * Under the gate's own explanation when a Mac Home can't be reached: one quiet line and the
 * Cloud Computer offer, at most once every two weeks, never for any other kind of Home.
 */
export function GateAsleepLine(props: {
  readonly macName: string;
  readonly deploymentId: string;
  readonly homeKind: HomeKind | null;
  /** Opens the Cloud Computer offer; without one, only the line shows. */
  readonly onOpen: (() => void) | null;
}) {
  const line = asleepGateLine({ macName: props.macName, homeKind: props.homeKind });
  const suggestion = useCloudSuggestion(`gate:${props.deploymentId}`, props.homeKind);
  if (line === null || !suggestion.visible) return null;
  return (
    <p className="asleep-moment asleep-moment--gate">
      <span>{line}</span>
      {props.onOpen ? <Suggestion onNotNow={suggestion.dismiss} onOpen={props.onOpen} /> : null}
    </p>
  );
}

/** Under a step the Home refused because the Device it needed is asleep. */
export function AsleepStepLine({ tool }: { readonly tool: ToolEntry }) {
  const { snapshot } = useShell();
  const navigate = useNavigate();
  const home = useHomeKind();
  const failure = asleepToolFailure(tool, snapshot.machines);
  const suggestion = useCloudSuggestion(`tool:${tool.callId}`, home.kind);
  if (!failure) return null;
  return (
    <p className="asleep-moment">
      <span>{failure.line}</span>
      {suggestion.visible ? (
        <Suggestion onNotNow={suggestion.dismiss} onOpen={() => void navigate(cloudComputerPath)} />
      ) : null}
    </p>
  );
}

/** Whether a step's output is the Home's asleep refusal, without reading anything else. */
export function isAsleepStep(tool: ToolEntry): boolean {
  return asleepToolFailure(tool, []) !== null;
}

/** What a window knows of the Home it was trying to reach. */
export interface UnreachableHome {
  readonly exposure: "loopback" | "networked";
  readonly deploymentId: string;
  readonly hostedHere: boolean;
  readonly macName: string;
  readonly portalOrigin: string | null;
}

/**
 * The gate's asleep line for the Home a window was trying to reach, deciding its kind from
 * what that window knows: the Host's last-known exposure, the Account's views, and whether
 * the Home runs on this computer. `home` is read only when the line is drawn, so a gate
 * that never shows it asks the Host for nothing. The offer opens on the Opensteer website,
 * since the gate stands in for the app.
 */
export function UnreachableHomeLine(props: {
  readonly desktopBridge: OpensteerDesktopBridge | null | undefined;
  readonly home: () => UnreachableHome | null;
}) {
  const cloud = useCloudComputer(cloudComputerAccountFor(props.desktopBridge));
  const home = props.home();
  if (!home) return null;
  const kind = homeKind({
    exposure: home.exposure,
    deploymentId: home.deploymentId,
    hostedHere: home.hostedHere,
    account: cloud.views,
  }).kind;
  const { desktopBridge } = props;
  const { portalOrigin } = home;
  const open = portalOrigin
    ? () => {
        const url = cloudComputerWebsite(portalOrigin, "home");
        if (desktopBridge) void desktopBridge.openExternalUrl({ url });
        else window.open(url, "_blank", "noopener,noreferrer");
      }
    : null;
  return (
    <GateAsleepLine
      deploymentId={home.deploymentId}
      homeKind={kind}
      macName={home.macName}
      onOpen={open}
    />
  );
}
