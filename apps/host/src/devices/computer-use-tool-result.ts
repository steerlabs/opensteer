import {
  formatComputerUseResultHead,
  type PhoneDisplayObservation,
  type IphoneScreenStatus,
  type ComputerUseObservation,
} from "@opensteer/protocol";
import type { ReplContent } from "../computer-use/computer-repl/messages.js";

const iphoneStatusMessages = {
  locked: "The iPhone is locked. Only the person can unlock it.",
  "lock-state-unknown": "The iPhone's lock state could not be confirmed.",
  "screen-off": "The iPhone display is off.",
  "screen-state-unknown": "The iPhone display state could not be confirmed.",
} satisfies Record<IphoneScreenStatus["reason"], string>;

export function iphoneScreenStatusContent(status: IphoneScreenStatus, name: string): ReplContent {
  const locked = status.locked === null ? "unknown" : status.locked ? "yes" : "no";
  return {
    type: "text",
    text: `${name}
Screen: ${status.screen}
Locked: ${locked}
${iphoneStatusMessages[status.reason]}`,
  };
}

/** The REPL owns emission order; observations have one text header, then a picture. */
export function computerObservationContent(
  observation: ComputerUseObservation | PhoneDisplayObservation,
  renderImages: boolean,
  computer: string,
): ReplContent[] {
  const screenshot = observation.screenshot;
  const content: ReplContent[] = [
    {
      type: "text",
      text: [
        formatComputerUseResultHead({
          appName: "app" in observation ? observation.app.displayName : computer,
          elementCount: observation.elementCount,
          geometry: observation.geometry,
          snapshot: "snapshot" in observation ? observation.snapshot : observation.observationId,
          performed: null,
          stoppedBecause: null,
          truncated: observation.truncated,
          windowTitle: "window" in observation ? observation.window.title : null,
        }),
        ...(observation.tree ? [observation.tree] : []),
        ...("windows" in observation && observation.windows.length
          ? [
              `Windows: ${JSON.stringify(observation.windows.map(({ windowId, title, current }) => ({ windowId, title, current })))}`,
            ]
          : []),
        ...("blockedBy" in observation && observation.blockedBy.length
          ? [`Blocked by: ${JSON.stringify(observation.blockedBy)}`]
          : []),
        ...("alone" in observation && observation.alone
          ? ["This window is on another Space or hidden; associated surfaces are excluded."]
          : []),
        ...("focusChanged" in observation && observation.focusChanged
          ? ["The app came to the front on its own; tell the person if they did not expect it."]
          : []),
        ...("screen" in observation
          ? [
              `Screen: ${observation.screen}`,
              `Locked: ${observation.locked === null ? "unknown" : observation.locked ? "yes" : "no"}`,
              `Secure lock: ${observation.secureLock === null ? "unknown" : observation.secureLock ? "yes" : "no"}`,
              `Foreground app: ${observation.foreground ? `${observation.foreground.label ?? observation.foreground.appId} (${observation.foreground.appId})` : "unknown"}`,
            ]
          : []),
        ...("screenshotUnavailable" in observation &&
        observation.screenshotUnavailable === "screen-off"
          ? [
              'The screen is off, so there is nothing to see. If this Device advertises wake, act with {"type":"wake"}; otherwise ask the person to turn it on.',
            ]
          : "screenshotUnavailable" in observation &&
              observation.screenshotUnavailable === "opensteer-app"
            ? [
                "The Opensteer app is in front. Agents may not see or operate it, so nothing of the screen is shared. Use an advertised navigation button, or launch an app returned by installed_apps, to continue.",
              ]
            : "screenshotUnavailable" in observation &&
                observation.screenshotUnavailable === "locked"
              ? [
                  "The phone is locked. Ask the person to unlock it physically; do not enter a passcode.",
                ]
              : "screenshotUnavailable" in observation &&
                  observation.screenshotUnavailable === "protected"
                ? ["The phone is showing protected content, so no screen content is shared."]
                : []),
        ...(!renderImages
          ? ["Screenshot unavailable in this engine."]
          : !screenshot &&
              (!("screenshotUnavailable" in observation) ||
                observation.screenshotUnavailable === "failed")
            ? [
                "No screenshot could be captured this time; the tree and its coordinates still apply.",
              ]
            : []),
      ].join("\n"),
    },
  ];
  if (screenshot && renderImages)
    content.push({
      type: "image",
      data: screenshot.base64,
      mimeType: screenshot.mime,
      _meta: { "codex/imageDetail": "original" },
    });
  return content;
}
