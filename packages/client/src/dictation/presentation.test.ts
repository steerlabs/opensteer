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
  expect(dictationNoticeMessage("model-unavailable", "日本語")).toBe(
    "日本語 isn't ready for dictation. Tap the mic to download it.",
  );
  expect(dictationNoticeMessage("download-failed", "English")).toBe(
    "Couldn't download English. Check your connection and storage, then try again.",
  );
});
