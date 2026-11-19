// @vitest-environment happy-dom
import type { ClientConnection, ClientConnectionState } from "@opensteer/client/connections";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import {
  ConnectionGateScope,
  ConnectionGateView,
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
    const words = node.querySelector<HTMLButtonElement>(".connection-pill__words")!;
    act(() => words.click());
    expect(document.querySelector(".connection-details")).not.toBeNull();
    words.focus();
    // Screen readers hear a region again when it moves: it stays where it was.
    const spoken = node.querySelector("[aria-live]");
    expect(spoken?.closest("[data-column]")).toBeNull();
    // The dock closes: the pill goes back over the main column, as the same element.
    render(false);
    expect(node.querySelector(".connection-pill")).toBe(pill);
    expect(pill?.closest("[data-column]")).toBeNull();
    expect(document.querySelector(".connection-details")).not.toBeNull();
    expect(document.activeElement).toBe(words);
    expect(node.querySelector("[aria-live]")).toBe(spoken);
    render(true);
    expect(node.querySelector(".connection-pill")).toBe(pill);
    expect(pill?.closest("[data-column]")).not.toBeNull();
  } finally {
    act(() => root.unmount());
    node.remove();
  }
});

it("respects presenter retry authority on the gate and details while keeping secondary actions visible", () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const makeConnection = (state: ClientConnectionState): ClientConnection =>
    ({
      getSnapshot: () => state,
      subscribe: () => () => undefined,
      retry: () => undefined,
    }) as unknown as ClientConnection;
  const base: ClientConnectionState = {
    ...unreachable,
    phase: "connecting",
    readyRevision: 0,
    route: "same-computer",
    trying: true,
  };
  try {
    // Slow in-flight local connect: honest connecting copy, no Try again, Other computers stays visible.
    const slowConnection = makeConnection({
      ...base,
      issue: { code: "connection", reason: "reconnecting", route: "same-computer" },
    });
    act(() =>
      root.render(
        <ConnectionGateScope>
          <ConnectionGateView
            connection={slowConnection}
            scope="app"
            secondary={{ label: "Other computers", onPress: () => undefined }}
          />
        </ConnectionGateScope>,
      ),
    );
    expect(node.textContent).toContain("Connecting to Mac mini…");
    expect(node.textContent).toContain("taking longer than usual");
    expect([...node.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Other computers",
    ]);

    // Offline gate: no Try again, Other computers stays visible.
    const offlineConnection = makeConnection({
      ...base,
      phase: "recovering",
      network: "offline",
      trying: false,
      issue: { code: "connection", reason: "offline" },
    });
    act(() =>
      root.render(
        <ConnectionGateScope>
          <ConnectionGateView
            connection={offlineConnection}
            scope="app"
            secondary={{ label: "Other computers", onPress: () => undefined }}
          />
        </ConnectionGateScope>,
      ),
    );
    expect(node.textContent).toContain("You're offline");
    expect([...node.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Other computers",
    ]);

    // Offline pill details popover also omits Try now.
    act(() =>
      root.render(
        <ConnectionGateScope>
          <ShellConnectionPill
            current={{ key: "personal", mark: "desktop", connection: offlineConnection }}
          />
        </ConnectionGateScope>,
      ),
    );
    const words = node.querySelector<HTMLButtonElement>(".connection-pill__words")!;
    act(() => words.click());
    const popover = document.querySelector(".connection-details");
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain("offline");
    expect(popover?.textContent).not.toContain("Try now");

    // Observed same-computer unreachable offers Try again (busy while trying) alongside Other computers.
    const localUnreachable = makeConnection({
      ...base,
      phase: "recovering",
      trying: true,
      issue: { code: "connection", reason: "unreachable", route: "same-computer" },
    });
    act(() =>
      root.render(
        <ConnectionGateScope>
          <ConnectionGateView
            connection={localUnreachable}
            scope="app"
            secondary={{ label: "Other computers", onPress: () => undefined }}
          />
        </ConnectionGateScope>,
      ),
    );
    expect(node.textContent).toContain("Opensteer isn't responding");
    expect(node.textContent).not.toContain("internet");
    const buttons = [...node.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Try again", "Other computers"]);
    expect(buttons[0]?.getAttribute("aria-busy")).toBe("true");
  } finally {
    act(() => root.unmount());
    node.remove();
  }
});
