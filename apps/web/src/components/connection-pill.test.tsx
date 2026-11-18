// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { ConnectionPill, type ConnectionPillNotice } from "./connection-pill.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function notice(source: string, label: string): ConnectionPillNotice {
  return { key: `${source}:connection:`, label, tone: "muted", trying: false, action: null };
}

function show(source: string, value: ConnectionPillNotice | null): string {
  if (!root) {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  }
  act(() => root!.render(<ConnectionPill notice={value} source={source} />));
  return document.querySelector("[aria-live]")?.textContent ?? "";
}

it("announces recovery only for the connection whose interruption was heard", () => {
  expect(show("personal", notice("personal", "Can't reach Studio"))).toBe("Can't reach Studio");
  // The route moved to a team that is fine: the computer did not come back.
  expect(show("team:a", null)).not.toBe("Connected");
  expect(show("team:b", notice("team:b", "Can't reach Acme"))).toBe("Can't reach Acme");
  expect(show("team:c", notice("team:c", "Can't reach Beta"))).toBe("Can't reach Beta");
  expect(show("team:c", null)).toBe("Connected");
});
