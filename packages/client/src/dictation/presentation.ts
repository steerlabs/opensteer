import type { DictationError } from "@opensteer/protocol/dictation";

export type DictationNoticeKind =
  DictationError | "interrupted" | "device-changed" | "limit" | "empty" | "downloaded";

export const dictationLabels = {
  dictate: "Dictate",
  stopButton: "Stop",
  stop: "Stop dictation",
  cancel: "Cancel dictation",
  cancelDownload: "Cancel download",
  cancelStarting: "Cancel",
  starting: "Starting microphone…",
  finishing: "Finishing…",
  openSettings: "Open Settings",
  dismissNotice: "Dismiss dictation notice",
} as const;

export function dictationStartLabel(language: string): string {
  return "Start dictation (" + language + ")";
}

export function dictationDownloadStatus(language: string, progress: number | null): string {
  return (
    "Downloading " +
    language +
    " for dictation…" +
    (progress === null ? "" : " " + Math.round(progress * 100) + "%")
  );
}

export function dictationElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

/**
 * `committed` says whether the session's words reached the draft, so a
 * notice never promises text that a failure before any speech did not keep.
 * The wording names the mic button without a click or tap, so it reads
 * naturally on a Mac and an iPhone alike.
 */
export function dictationNoticeMessage(
  kind: DictationNoticeKind,
  context: { language: string; committed: boolean },
): string {
  const kept = context.committed ? " Your words so far are in the message." : "";
  switch (kind) {
    case "permission-denied":
      return "Allow microphone access in Settings to dictate.";
    case "busy":
      return "Dictation is already on in another window.";
    case "microphone-unavailable":
      return "Couldn't start the microphone. Check your input and try again.";
    case "model-unavailable":
      return context.language + " isn't ready for dictation. Use the mic to download it.";
    case "download-failed":
      return (
        "Couldn't download " +
        context.language +
        ". Check your connection and storage, then try again."
      );
    case "recognition-failed":
      return "Dictation stopped unexpectedly." + kept;
    case "service-unavailable":
      return "Dictation isn't responding. Try again.";
    case "interrupted":
      return "Dictation stopped." + kept;
    case "device-changed":
      return "Your microphone changed." + kept + " Use the mic to keep going.";
    case "limit":
      return "Dictation stops after 10 minutes. Use the mic to keep going.";
    case "empty":
      return "No speech detected.";
    case "downloaded":
      return context.language + " is ready. Use the mic to dictate.";
  }
}
