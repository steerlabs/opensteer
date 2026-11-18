// @vitest-environment happy-dom
import type { ClientConnection, ClientConnectionState } from "@opensteer/client/connections";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import {
  ConnectionGateScope,
  ShellConnectionPill,
  useConnectionPillSlot,
  type ShellConnectionSource,
} from "./connection-shell.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const unreachable: ClientConnectionState = {
  epoch: 1,
  issue: { code: "connection", reason: "unreachable" },
  lastConnectedAt: null,
  name: "Mac mini",
  network: "online",
  pathRevision: 0,
  phase: "recovering",
  readyRevision: 1,
  route: null,
  scope: null,
  showInterruption: true,
  target: "computer",
  trying: false,
  visibility: "foreground",
};
const source: ShellConnectionSource = {
  key: "personal",
  mark: "desktop",
  connection: {
    getSnapshot: () => unreachable,
    subscribe: () => () => undefined,
    retry: () => undefined,
  } as unknown as ClientConnection,
};

function Column() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useConnectionPillSlot(element);
  return <section data-column ref={setElement} />;
}

it("keeps the same pill, details open, as a layout's column takes it and gives it back", () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const render = (column: boolean) =>
    act(() =>
      root.render(
        <ConnectionGateScope>
          <main>
            <ShellConnectionPill current={source} />
            {column ? <Column /> : null}
          </main>
        </ConnectionGateScope>,
      ),
    );
  try {
    render(true);
    const pill = node.querySelector(".connection-pill");
    expect(pill?.closest("[data-column]")).not.toBeNull();
    act(() => node.querySelector<HTMLButtonElement>(".connection-pill__words")!.click());
    expect(document.querySelector(".connection-details")).not.toBeNull();
    // The dock closes: the pill goes back over the main column, as the same element.
    render(false);
    expect(node.querySelector(".connection-pill")).toBe(pill);
    expect(pill?.closest("[data-column]")).toBeNull();
    expect(document.querySelector(".connection-details")).not.toBeNull();
    render(true);
    expect(node.querySelector(".connection-pill")).toBe(pill);
    expect(pill?.closest("[data-column]")).not.toBeNull();
  } finally {
    act(() => root.unmount());
    node.remove();
  }
});
