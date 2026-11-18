import { testHostConnection } from "@opensteer/client/test-support";
// @vitest-environment happy-dom

import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import type { NeedsYouPage, NeedsYouTeamAskEntry } from "@opensteer/protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

// Failure journeys: a teammate's ask opens a dialog instead of the task it
// waits in, or an ask whose task is gone can't be put away.
const harness = vi.hoisted(() => ({ client: null as HostClient | null, navigate: vi.fn() }));
vi.mock("react-native", () => {
  type Children = { readonly children?: ReactNode };
  return {
    Platform: { OS: "ios", Version: "18.0", select: (choices: { ios?: unknown }) => choices.ios },
    Pressable: (
      props: Children & { readonly disabled?: boolean; readonly onPress?: () => void },
    ) => (
      <button disabled={props.disabled} onClick={props.onPress}>
        {props.children}
      </button>
    ),
    ScrollView: ({ children }: Children) => <div>{children}</div>,
    StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
    View: ({ children }: Children) => <div>{children}</div>,
  };
});
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: harness.navigate }),
}));
vi.mock(
  "../ui/action-line.js",
  async () => (await import("../../test-support/action-line-mocks.js")).actionLine,
);
vi.mock(
  "../ui/placeholder.js",
  async () => (await import("../../test-support/action-line-mocks.js")).placeholder,
);
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { readonly children?: ReactNode }) => <main>{children}</main>,
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => harness.client,
}));

const { NeedsYouScreen } = await import("./needs-you.js");

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const threadId = "thr_0192f4a1-2222-4000-8000-000000000001";
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  harness.navigate.mockReset();
  document.body.innerHTML = "";
});

function ask(
  requestId: string,
  extra: Partial<NeedsYouTeamAskEntry>,
  displayName: string,
): NeedsYouTeamAskEntry {
  return {
    consentExpiresAt: "2026-11-15T10:00:00.000Z",
    createdAt: "2026-11-14T10:00:00.000Z",
    kind: "team-ask",
    presentation: {
      asker: { actor: "human", displayName },
      bodyMarkdown: "@My agent is CI green yet?",
    },
    requestId,
    teamId: "dep_0192f4a1-1111-4000-8000-0000000000aa",
    ...extra,
  } as NeedsYouTeamAskEntry;
}

function mount(entries: NeedsYouPage["entries"]) {
  const decideTeamAsk = vi.fn(async (_decision: object) => undefined);
  const snapshot = {
    connection: "connected",
    deploymentId,
    needsYou: { count: entries.length, entries, window: { hasMore: false } },
    session: "authenticated",
    user: { id: "usr_reader" },
  } as unknown as HostSnapshot;
  harness.client = {
    decideTeamAsk,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  } as unknown as HostClient;
  Object.assign(harness.client, { connection: testHostConnection(harness.client) });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<NeedsYouScreen route={{ params: { deploymentId } }} />));
  return { container, decideTeamAsk };
}

function control(container: HTMLElement, words: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(words),
  );
  if (found === undefined) throw new Error(`No control saying ${words}`);
  return found;
}

it("opens the task a teammate's ask waits in, and dismisses one whose task is gone", async () => {
  const { container, decideTeamAsk } = mount([
    ask("treq_waiting", { task: { messageId: "msg_1", revision: 0, threadId } } as never, "Maya"),
    ask("treq_failed", { failureReason: "Your computer couldn't take this ask." }, "Leo"),
  ]);
  await act(async () => control(container, "Maya").click());
  expect(harness.navigate).toHaveBeenCalledWith("Thread", { deploymentId, threadId });
  expect(decideTeamAsk).not.toHaveBeenCalled();

  expect(container.textContent).toContain("Your computer couldn't take this ask.");
  await act(async () => control(container, "Dismiss").click());
  expect(decideTeamAsk).toHaveBeenCalledWith({
    decision: "decline",
    requestId: "treq_failed",
    teamId: "dep_0192f4a1-1111-4000-8000-0000000000aa",
  });
  expect(harness.navigate).toHaveBeenCalledTimes(1);
});

it("dismisses a failed ask whose task remains, and still opens that task", async () => {
  const { container, decideTeamAsk } = mount([
    ask(
      "treq_failed",
      {
        failureReason: "The team link was revoked.",
        task: { messageId: "msg_1", revision: 1, threadId },
      } as never,
      "Maya",
    ),
  ]);
  expect(container.textContent).toContain("The team link was revoked.");
  await act(async () => control(container, "Maya").click());
  expect(harness.navigate).toHaveBeenCalledWith("Thread", { deploymentId, threadId });
  await act(async () => control(container, "Dismiss").click());
  expect(decideTeamAsk).toHaveBeenCalledWith({
    decision: "decline",
    requestId: "treq_failed",
    teamId: "dep_0192f4a1-1111-4000-8000-0000000000aa",
  });
});
