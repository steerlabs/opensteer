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
  transcriptVoice,
  type MessageEntry,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import {
  mcpPresentationScenarios,
  mcpPresentationTool,
  threadActivityScenarios,
  withAccountPreparing,
} from "@opensteer/client/test-support";
import { composerView, type ComposerState } from "./composer-model.js";
import { Message, TranscriptGroupRow, WorkingIndicator } from "./transcript.js";

// The indicator is drawn by the real component with DOM hosts; the platform
// primitives and animation drivers are outside this check.
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26" },
  useWindowDimensions: () => ({ fontScale: 1 }),
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useSafeAreaFrame: () => ({ height: 844, width: 390, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => <div data-working>{children}</div>,
  },
  LayoutAnimationConfig: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/motion.js", () => ({ appear: undefined, exit: undefined }));
vi.mock("./app-card.js", () => ({ AppCard: () => null }));
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
vi.mock("./message-hold.js", () => ({
  MessageHold: (props: { children: ReactNode }) => props.children,
  MessageMore: (props: { reportId: string }) => <i data-report={props.reportId} />,
}));
vi.mock("../ui/copy-mark.js", () => ({ CopyMark: () => null }));
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
  voice: false,
};

describe("a Thread's activity on the phone", () => {
  function mount(node: ReactNode) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(node));
    return container;
  }

  it.each(mcpPresentationScenarios)(
    "presents %s while running and after completion",
    (name, args, active, done) => {
      for (const running of [true, false]) {
        const group = groupTranscriptEntries([mcpPresentationTool(name, args, running)])[0]!;
        const container = mount(
          <TranscriptGroupRow
            group={group}
            open={true}
            onToggleOpen={() => {}}
            highlightRequestId={null}
            onOpenStep={() => {}}
            onOpenThread={() => {}}
            spacingTop={0}
            homeThreadId={null}
            viewerUserId={null}
            workspaces={[]}
          />,
        );
        expect(container.textContent).toContain(running ? active : done);
      }
    },
  );

  it.each([true, false])(
    "attributes connection input to its agent (conversation=%s)",
    (conversation) => {
      const message: MessageEntry = {
        author: { kind: "connection", connectionId: "mcn_external", displayName: "Research agent" },
        body: "Check these sources",
        createdAt: "2026-11-03T10:00:00.000Z",
        id: "message-connection",
        kind: "message",
        messageKind: "input",
        runId: null,
      };
      const group = { kind: "message", key: message.id, entry: message } as const;
      expect(transcriptVoice(group, "owner")).toBe("input");
      const container = mount(
        <Message
          conversation={conversation}
          message={message}
          homeThreadId={null}
          onReply={undefined}
          open={true}
          onToggle={() => {}}
          onOpenThread={() => {}}
          viewerUserId="owner"
          workspaces={[]}
        />,
      );
      expect(container.textContent).toContain("Research agent");
      expect(container.textContent).toContain(message.body);
    },
  );

  it.each([
    ["with words", "The migration is ready."],
    ["with nothing but files", ""],
  ])("keeps what an agent wrote in a task reportable, %s", (_name, body) => {
    const message: MessageEntry = {
      author: { kind: "platform", cause: "run-recovery" },
      body,
      createdAt: "2026-11-03T10:00:00.000Z",
      id: "message-reply",
      kind: "message",
      messageKind: "assistant",
      runId: null,
    };
    const props = {
      conversation: false,
      homeThreadId: null,
      message,
      onOpenThread: () => {},
      onReply: undefined,
      onToggle: () => {},
      open: true,
      viewerUserId: "owner",
      workspaces: [],
    };
    const finished = mount(<Message {...props} />);
    expect(finished.querySelector("[data-report]")?.getAttribute("data-report")).toBe(message.id);

    const streaming = mount(<Message {...props} message={{ ...message, streaming: true }} />);
    expect(streaming.querySelector("[data-report]")).toBeNull();
  });

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
