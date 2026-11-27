// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { TabId, TabLayout } from "@opensteer/core";
import { tabStrip, type TabStrip } from "@opensteer/client/host";
import type { RowMotion } from "./row-motion.js";
import type { SortRow, TabMove } from "./tab-sort.js";
import { useTabSort } from "./use-tab-sort.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const stripOf = (...ids: string[]) =>
  tabStrip(
    { revision: 1, items: ids.map((id) => ({ kind: "tab", tabId: id as TabId })) } as TabLayout,
    { has: () => true },
  );
const rowsOf = (strip: TabStrip): SortRow[] =>
  strip.entries.flatMap((entry): SortRow[] =>
    entry.kind === "tab"
      ? [{ kind: "tab", key: entry.tabId, tabId: entry.tabId, group: null }]
      : [],
  );

/**
 * A list on the hook: the Host's order is `host`, a move is answered when the
 * test says, and every render's order is recorded.
 */
function mount() {
  const renders: string[] = [];
  const held: (string | null)[] = [];
  const answers: ((host: TabStrip | null) => void)[] = [];
  let setHost: (strip: TabStrip) => void = () => undefined;
  function List() {
    const [host, set] = useState(() => stripOf("a", "b", "c", "d"));
    setHost = set;
    const list = useRef<HTMLUListElement | null>(null);
    const motion = useRef({
      hold: (_positions: unknown, keep: string | null) => held.push(keep),
    } as unknown as RowMotion);
    const sort = useTabSort({
      strip: host,
      rowsOf,
      movable: true,
      list,
      motion,
      move: (_move: TabMove) =>
        new Promise<void>((resolve) =>
          answers.push((answer) => {
            // The Host's answer lands in its order before the move settles, as the store applies it.
            if (answer) set(answer);
            resolve();
          }),
        ),
      announce: () => undefined,
      title: (row) => row.key,
    });
    const shown = sort.lift?.strip ?? sort.strip;
    renders.push(shown.ordered.join(" "));
    return (
      <ul ref={list}>
        {shown.ordered.map((tabId) => (
          <li data-motion-key={tabId} key={tabId}>
            <button onKeyDown={(event) => sort.handle.keyMove(event, tabId)} type="button">
              {tabId}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(<List />);
  });
  const press = (key: string) =>
    act(() => {
      const button = [...document.querySelectorAll("button")].find((b) => b.textContent === key)!;
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", metaKey: true, bubbles: true }),
      );
    });
  const order = () => [...document.querySelectorAll("li")].map((li) => li.textContent).join(" ");
  return { renders, held, answers, press, order, setHost: (strip: TabStrip) => setHost(strip) };
}

it("a move shows in the same render that holds the rows' places, and the Host's answer moves nothing more", async () => {
  const list = mount();
  list.press("b");
  // Asked, not yet answered: the list shows the move, kept in view from where the rows stood.
  expect(list.held).toEqual(["b"]);
  expect(list.order()).toBe("a c b d");
  expect(list.renders.at(-1)).toBe("a c b d");
  const before = list.renders.length;
  await act(async () => list.answers[0]!(stripOf("a", "c", "b", "d")));
  expect(list.order()).toBe("a c b d");
  // No render after the drop ever showed another order.
  expect(new Set(list.renders.slice(before - 1))).toEqual(new Set(["a c b d"]));
});

it("a move the Host refuses, or whose answer never says, goes back to the Host's order", async () => {
  const list = mount();
  list.press("b");
  expect(list.order()).toBe("a c b d");
  await act(async () => list.answers[0]!(null));
  expect(list.order()).toBe("a b c d");
});

it("the Host's order changing meanwhile shows under the move still waiting for its answer", async () => {
  const list = mount();
  list.press("b");
  act(() => list.setHost(stripOf("a", "b", "c", "d", "e")));
  expect(list.order()).toBe("a c b d e");
  await act(async () => list.answers[0]!(stripOf("a", "c", "b", "d", "e")));
  expect(list.order()).toBe("a c b d e");
});
