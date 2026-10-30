import { expect, it } from "vitest";
import {
  dictationDownloadStatus,
  dictationElapsed,
  dictationLabels,
  dictationNoticeMessage,
  dictationStartLabel,
} from "./presentation.js";

it("shares accessible labels, progress and timer formatting across composers", () => {
  expect(dictationLabels.starting).toBe("Starting microphone…");
  expect(dictationLabels.finishing).toBe("Finishing…");
  expect(dictationStartLabel("English")).toBe("Start dictation (English)");
  expect(dictationDownloadStatus("English", 0.42)).toBe("Downloading English for dictation… 42%");
  expect(dictationDownloadStatus("English", null)).toBe("Downloading English for dictation…");
  expect(dictationElapsed(61_999)).toBe("1:01");
  expect(
    dictationNoticeMessage("model-unavailable", { language: "日本語", committed: false }),
  ).toBe("日本語 isn't ready for dictation. Use the mic to download it.");
  expect(dictationNoticeMessage("download-failed", { language: "English", committed: false })).toBe(
    "Couldn't download English. Check your connection and storage, then try again.",
  );
});

it("promises recovered words only when they reached the draft", () => {
  const interrupted = (committed: boolean) =>
    dictationNoticeMessage("interrupted", { language: "English", committed });
  expect(interrupted(true)).toBe("Dictation stopped. Your words so far are in the message.");
  expect(interrupted(false)).toBe("Dictation stopped.");
  expect(
    dictationNoticeMessage("recognition-failed", { language: "English", committed: false }),
  ).toBe("Dictation stopped unexpectedly.");
  expect(dictationNoticeMessage("device-changed", { language: "English", committed: true })).toBe(
    "Your microphone changed. Your words so far are in the message. Use the mic to keep going.",
  );
});
