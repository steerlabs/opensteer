// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { NeedsYouTeamAskEntrySchema, type NeedsYouTeamAskEntry } from "@opensteer/protocol";
import { NeedsYouRow } from "./needs-you-row.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function ask(overrides: Partial<NeedsYouTeamAskEntry>): NeedsYouTeamAskEntry {
  const teamId = createId("deployment");
  return NeedsYouTeamAskEntrySchema.parse({
    consentExpiresAt: "2026-11-21T12:00:00.000Z",
    createdAt: "2026-11-14T12:00:00.000Z",
    kind: "team-ask",
    presentation: {
      asker: { actor: "human", displayName: "Maya", teamUserId: createId("user") },
      attachments: [],
      audience: {
        channelKind: "public",
        channelName: "general",
        memberCount: 4,
        peopleOnly: false,
        teamName: "Acme",
      },
      bodyMarkdown: "Can you check the ferry times?",
      destination: { channelId: createId("teamChannel"), teamId, threadRootId: "1" },
    },
    requestId: createId("teamAgentRequest"),
    teamId,
    ...overrides,
  });
}

function mount(entry: NeedsYouTeamAskEntry) {
  const onDismiss = vi.fn();
  const onOpen = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <ul>
        <NeedsYouRow entry={entry} onDismiss={onDismiss} onOpen={onOpen} />
      </ul>,
    ),
  );
  const buttons = () => [...container.querySelectorAll("button")];
  return { buttons, onDismiss, onOpen };
}

const task = { messageId: createId("message"), revision: 1, threadId: createId("thread") };

it("a failed ask can be dismissed whether or not its task survived, and opens one that did", () => {
  const kept = mount(ask({ failureReason: "The team link was revoked.", task }));
  const dismiss = kept.buttons().find((node) => node.textContent === "Dismiss");
  expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss Maya · #general");
  act(() => dismiss!.click());
  expect(kept.onDismiss).toHaveBeenCalledTimes(1);
  act(() => kept.buttons()[0]!.click());
  expect(kept.onOpen).toHaveBeenCalledTimes(1);
  act(() => root?.unmount());

  const removed = mount(ask({ failureReason: "The team link was revoked." }));
  expect(removed.buttons().map((node) => node.textContent)).toEqual(["Dismiss"]);
  act(() => root?.unmount());

  // Waiting in its task, the ask is answered there.
  const waiting = mount(ask({ task }));
  expect(waiting.buttons().some((node) => node.textContent === "Dismiss")).toBe(false);
  root = null;
});
