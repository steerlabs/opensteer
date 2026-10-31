// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  groupTranscriptEntries,
  threadActivity,
  threadActivityIndicator,
  threadStartHold,
  threadStopTarget,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { threadActivityScenarios, withAccountPreparing } from "@opensteer/client/test-support";
import { composerView, type ComposerState } from "./composer-model.js";
import { WorkingIndicator } from "./transcript.js";

// The indicator is drawn by the real component with DOM hosts; the platform
// primitives and animation drivers are outside this check.
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => <div data-working>{children}</div>,
  },
}));
vi.mock("../ui/motion.js", () => ({ appear: undefined, exit: undefined }));
vi.mock("../ui/sheet.js", () => ({ Sheet: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  StatusDot: () => null,
  TypingDots: () => null,
  monoFontFamily: "monospace",
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/chat-orb.js", () => ({ ChatOrb: () => <i data-chat-orb /> }));
vi.mock("../ui/workspace-mark.js", () => ({
  WorkspaceMark: () => null,
  WorkspaceIconGlyph: () => null,
}));
vi.mock("./message-menu.js", () => ({ MessageMenu: () => null }));
vi.mock("./attachment-views.js", () => ({ MessageAttachments: () => null }));
vi.mock("../markdown/markdown.js", () => ({
  Markdown: ({ text }: { text: string }) => <p>{text}</p>,
  PlainProse: ({ text }: { text: string }) => <p>{text}</p>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

// The seeded Thread, on the account the mock names Codex.
const seeded = { harnessLabel: "Codex", id: "thr_00000000-0000-4000-8000-000000000004" };

const idleComposer: ComposerState = {
  attachments: 0,
  attachmentsReady: true,
  canRespond: true,
  disabledReason: null,
  focused: false,
  pendingCommand: false,
  presenting: false,
  readOnly: false,
  running: false,
  sending: false,
  text: "",
  textHidden: false,
};

describe("a Thread's activity on the phone", () => {
  it.each(threadActivityScenarios(seeded).map((scenario) => [scenario.name, scenario] as const))(
    "shows the line and Stop every client shows when %s",
    (_name, scenario) => {
      const client = new MockHostClient({ latencyMs: 0 });
      const snapshot = client.getSnapshot();
      client.dispose();
      const summary = snapshot.threads.find(({ id }) => id === seeded.id);
      const harness = snapshot.harnesses.find(({ id }) => id === summary?.harnessInstanceId);
      if (!summary || !harness) throw new Error("The seeded Thread is missing.");
      const environments = scenario.accountPreparing
        ? withAccountPreparing(snapshot.environments, harness)
        : snapshot.environments;
      // What the Thread screen derives and hands to the transcript and composer.
      const thread = { ...summary, status: scenario.status };
      const activity = threadActivity({
        entries: scenario.entries,
        runQueue: scenario.runQueue,
        thread,
      });
      const startHold = threadStartHold({ environments, runQueue: scenario.runQueue, thread });
      const indicator = threadActivityIndicator(activity, {
        conversation: false,
        groups: groupTranscriptEntries(scenario.entries, { startHold }),
        startHold,
      });
      const running = threadStopTarget({ runQueue: scenario.runQueue, thread }) !== null;

      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      act(() => root.render(indicator ? <WorkingIndicator indicator={indicator} /> : null));
      expect(container.querySelector("[data-working]")?.textContent ?? null).toBe(
        scenario.expected.line,
      );

      const stop = composerView({ ...idleComposer, running }).action === "stop";
      expect(!stop ? "absent" : activity === "stopping" ? "disabled" : "enabled").toBe(
        scenario.expected.stop,
      );
    },
  );
});
