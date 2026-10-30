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

export function dictationNoticeMessage(kind: DictationNoticeKind, language: string): string {
  switch (kind) {
    case "permission-denied":
      return "Allow microphone access in Settings to dictate.";
    case "busy":
      return "Dictation is already on in another window.";
    case "microphone-unavailable":
      return "Couldn't start the microphone. Check your input and try again.";
    case "model-unavailable":
      return language + " isn't ready for dictation. Tap the mic to download it.";
    case "download-failed":
      return (
        "Couldn't download " + language + ". Check your connection and storage, then try again."
      );
    case "recognition-failed":
      return "Dictation stopped unexpectedly. Your words so far are in the message.";
    case "service-unavailable":
      return "Dictation isn't responding. Try again.";
    case "interrupted":
      return "Dictation stopped. Your words so far are in the message.";
    case "device-changed":
      return "Your microphone changed. Tap the mic to keep going.";
    case "limit":
      return "Dictation stops after 10 minutes. Tap the mic to keep going.";
    case "empty":
      return "No speech detected.";
    case "downloaded":
      return language + " is ready. Tap the mic to dictate.";
  }
}
