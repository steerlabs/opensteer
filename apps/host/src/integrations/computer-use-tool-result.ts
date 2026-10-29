import {
  formatComputerUseResultHead,
  type AndroidPhoneObservation,
  type ComputerUseObservation,
} from "@opensteer/protocol";
import type { ReplContent } from "../computer-use/computer-repl/messages.js";

/** The REPL owns emission order; observations have one text header, then a picture. */
export function computerObservationContent(
  observation: ComputerUseObservation | AndroidPhoneObservation,
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
              `Windows: ${JSON.stringify(observation.windows.map(({ id, title, current }) => ({ id, title, current })))}`,
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
              `Locked: ${observation.locked ? "yes" : "no"}`,
              `Secure lock: ${observation.secureLock ? "yes" : "no"}`,
              `Foreground app: ${observation.foreground ? `${observation.foreground.label ?? observation.foreground.packageName} (${observation.foreground.packageName})` : "none"}`,
            ]
          : []),
        ...("screenshotUnavailable" in observation &&
        observation.screenshotUnavailable === "screen-off"
          ? [
              'The screen is off, so there is nothing to see. Act with {"type":"wake"} to turn it on.',
            ]
          : "screenshotUnavailable" in observation &&
              observation.screenshotUnavailable === "opensteer-app"
            ? [
                'The Opensteer Agent Phone app is in front. Agents may not see or operate it, so nothing of the screen is shared. Act with {"type":"navigate","to":"home"}, or launch another app, to continue.',
              ]
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
