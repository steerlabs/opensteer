// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRowView, MessageView, TeamSidebarView, TimelineItem } from "./team-models.js";

const drawn = vi.hoisted(() => ({ bodies: [] as string[], glyphs: 0 }));

// Each message row draws one body and each channel row one glyph: counting
// them counts the rows React drew.
vi.mock("./message-body.js", async (actual) => {
  const real = await actual<typeof import("./message-body.js")>();
  return {
    ...real,
    MessageBody: (props: Parameters<typeof real.MessageBody>[0]) => {
      drawn.bodies.push(props.text);
      return createElement(real.MessageBody, props);
    },
  };
});
vi.mock("./team-marks.js", async (actual) => {
  const real = await actual<typeof import("./team-marks.js")>();
  return {
    ...real,
    ChannelGlyph: (props: Parameters<typeof real.ChannelGlyph>[0]) => {
      drawn.glyphs++;
      return createElement(real.ChannelGlyph, props);
    },
  };
});

const { MessageList } = await import("./message-list.js");
const { TeamSide } = await import("./team-sidebar.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
beforeEach(() => {
  drawn.bodies.length = 0;
  drawn.glyphs = 0;
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const maya = { id: "usr_maya", name: "Maya Chen", handle: "maya", tint: "#c97a5c" };
/** A fresh view of the same message, as a rebuilt timeline makes one. */
const message = (id: number, body = `Message ${id}`): TimelineItem => ({
  kind: "message",
  message: {
    id: String(id),
    author: { kind: "person", person: { ...maya } },
    at: new Date(Date.UTC(2026, 10, 11, 9, id)).toISOString(),
    body,
    mentions: [],
    files: [],
  } satisfies MessageView,
});

function render(node: React.ReactNode): (next: React.ReactNode) => void {
  const container = document.createElement("div");
  container.style.height = "600px";
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return (next) => act(() => root.render(next));
}

describe("what redraws in team chat", () => {
  it("draws only the changed message when a timeline is rebuilt with one edit", () => {
    const items = (edited: string) =>
      Array.from({ length: 8 }, (_, index) =>
        index === 3 ? message(index, edited) : message(index),
      );
    const list = (rows: TimelineItem[]) => (
      <MessageList
        actions={{ onOpenThread: () => undefined }}
        firstUnreadId={null}
        hasOlder={false}
        items={rows}
        label="support"
      />
    );
    const rerender = render(list(items("Before")));
    expect(drawn.bodies).toHaveLength(8);
    drawn.bodies.length = 0;

    // A new timeline, new view objects and a new actions object: only row 3 changed.
    rerender(list(items("After")));

    expect(drawn.bodies).toEqual(["After"]);
  });

  it("draws only the channel row whose count changed, not the side around it", () => {
    const row = (id: string, mentions = 0): ChannelRowView => ({
      id,
      kind: "public",
      name: id,
      unread: mentions > 0,
      mentions,
      peopleOnly: false,
    });
    const view = (launchMentions: number): TeamSidebarView => ({
      id: "team",
      tile: { name: "Acme", color: "#c97a5c" },
      connection: "online",
      channels: ["general", "launch", "support", "design"].map((id) =>
        row(id, id === "launch" ? launchMentions : 0),
      ),
      dms: [],
      moreDms: 0,
    });
    const actions = { onOpenChannel: () => undefined };
    const rerender = render(<TeamSide actions={actions} team={view(0)} />);
    expect(drawn.glyphs).toBe(4);
    drawn.glyphs = 0;

    rerender(<TeamSide actions={actions} team={view(0)} />);
    expect(drawn.glyphs).toBe(0);

    rerender(<TeamSide actions={actions} team={view(2)} />);
    expect(drawn.glyphs).toBe(1);
  });
});
