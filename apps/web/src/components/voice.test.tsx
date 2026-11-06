// @vitest-environment happy-dom
import type { VoiceSnapshot } from "@opensteer/client/voice";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InputSurface } from "./input-surface.js";
import { VoiceContext } from "@opensteer/client/react";
import { VoiceIsland, type VoiceControls } from "./voice.js";

vi.mock("./app-shell.js", () => ({
  useShell: () => ({
    hostClient: {},
    snapshot: { threads: [], user: null, waitingRequests: [] },
    reportActionError: vi.fn(),
  }),
}));
vi.mock("./workspace/composer-context.js", () => ({ useComposerContext: () => null }));
vi.mock("./pending-sends.js", () => ({ usePendingSends: () => ({ sends: [] }) }));
vi.mock("./composer.js", () => ({ Composer: () => <textarea aria-label="Task message" /> }));
const iconRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./icon.js", () => ({
  Icon: () => {
    iconRenders.count += 1;
    return <svg />;
  },
}));

it("docks an active call above the latest task composer and floats only without a visible composer", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const snapshot: VoiceSnapshot = {
    available: true,
    phase: "listening",
    muted: false,
    heard: null,
    spoken: null,
    since: null,
    activity: null,
    tasks: 0,
    ask: null,
    notice: null,
  };
  const controller: VoiceControls = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    subscribeLevel: () => () => undefined,
    openThread: vi.fn(async () => null),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setMuted: vi.fn(),
    dismissNotice: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const task = (id: string, hidden = false, offScreen = false) => (
    <section aria-label={id} key={id}>
      <InputSurface
        threadId={id}
        disabled={false}
        running={false}
        placeholder="Task"
        composerHidden={hidden}
        voiceHidden={offScreen}
      />
    </section>
  );
  const draw = async (first: boolean, second = false, hidden = false, offScreen = false) =>
    act(async () =>
      root.render(
        <VoiceContext value={controller}>
          <VoiceIsland />
          {first ? task("First task", hidden, offScreen) : null}
          {second ? task("Second task") : null}
        </VoiceContext>,
      ),
    );
  try {
    await draw(true);
    const dock = () => container.querySelector(".voice-island--docked");
    expect(dock()?.closest('[aria-label="First task"]')).not.toBeNull();
    expect(container.querySelector(".voice-float")).toBeNull();
    expect(
      dock()!.compareDocumentPosition(container.querySelector("textarea")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await draw(true, true);
    expect(dock()?.closest('[aria-label="Second task"]')).not.toBeNull();
    await draw(true);
    expect(dock()?.closest('[aria-label="First task"]')).not.toBeNull();
    await draw(false);
    expect(container.querySelector(".voice-float .voice-island")).not.toBeNull();
    await draw(true);
    expect(dock()).not.toBeNull();
    expect(container.querySelector(".voice-float")).toBeNull();
    await draw(true, false, true);
    expect(container.querySelector(".voice-float .voice-island")).not.toBeNull();
    // A phone's closed sheet keeps its composer mounted but off screen: the call
    // must not dock out of reach.
    await draw(true, false, false, true);
    expect(container.querySelector(".voice-float .voice-island")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("shows the agent's step beside its words and glints once when the call changes the screen", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let snapshot: VoiceSnapshot = {
    available: true,
    phase: "thinking",
    muted: false,
    heard: "Open my reading list",
    spoken: null,
    since: null,
    activity: "browser",
    tasks: 0,
    ask: null,
    notice: null,
  };
  const listeners = new Set<() => void>();
  let shown: () => void = () => undefined;
  const controller: VoiceControls = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    subscribeLevel: () => () => undefined,
    subscribeShown: (listener) => {
      shown = listener;
      return () => undefined;
    },
    openThread: vi.fn(async () => null),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setMuted: vi.fn(),
    dismissNotice: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <VoiceContext value={controller}>
          <VoiceIsland />
        </VoiceContext>,
      ),
    );
    const island = container.querySelector(".voice-island")!;
    expect(island.getAttribute("data-phase")).toBe("thinking");
    expect(island.querySelector(".voice-island__activity svg")).not.toBeNull();
    expect(island.querySelector('[role="status"]')?.textContent).toBe("Working");
    expect(island.querySelector(".voice-island__caption")?.textContent).toBe(
      "Open my reading list",
    );
    const animate = vi.fn();
    Object.assign(island.querySelector(".voice-island__glow")!, { animate });
    shown();
    expect(animate).toHaveBeenCalledTimes(1);

    snapshot = { ...snapshot, phase: "listening", heard: null, activity: null };
    await act(async () => listeners.forEach((listener) => listener()));
    expect(island.querySelector(".voice-island__activity")).toBeNull();
    expect(island.querySelector('[role="status"]')?.textContent).toBe("Listening");
    expect(island.querySelector(".voice-island__caption")?.getAttribute("data-gone")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("carries what needs the person on the bar, and claims room over a place", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const snapshot: VoiceSnapshot = {
    available: true,
    phase: "listening",
    muted: false,
    heard: null,
    spoken: null,
    since: null,
    activity: null,
    tasks: 2,
    ask: null,
    notice: null,
  };
  const controller: VoiceControls = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    subscribeLevel: () => () => undefined,
    openThread: vi.fn(async () => null),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setMuted: vi.fn(),
    dismissNotice: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <VoiceContext value={controller}>
          <VoiceIsland ask={<p className="fixture-ask">Sign in</p>} />
        </VoiceContext>,
      ),
    );
    const float = container.querySelector(".voice-float")!;
    expect(float.firstElementChild?.className).toBe("fixture-ask");
    expect(float.querySelector(".voice-island__tasks")?.textContent).toBe("2 tasks");
    expect(document.documentElement.style.getPropertyValue("--voice-reserve")).not.toBe("");
    await act(async () => root.unmount());
    expect(document.documentElement.style.getPropertyValue("--voice-reserve")).toBe("");
  } finally {
    container.remove();
  }
});

it("redraws only the words as a caption streams in", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let snapshot: VoiceSnapshot = {
    available: true,
    phase: "hearing",
    muted: false,
    heard: "Open",
    spoken: null,
    since: null,
    activity: null,
    tasks: 0,
    ask: null,
    notice: null,
  };
  const listeners = new Set<() => void>();
  const controller: VoiceControls = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    subscribeLevel: () => () => undefined,
    openThread: vi.fn(async () => null),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setMuted: vi.fn(),
    dismissNotice: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <VoiceContext value={controller}>
          <VoiceIsland />
        </VoiceContext>,
      ),
    );
    const controlsDrawn = iconRenders.count;
    for (const heard of ["Open my", "Open my reading", "Open my reading list"]) {
      snapshot = { ...snapshot, heard };
      await act(async () => listeners.forEach((listener) => listener()));
      expect(container.querySelector(".voice-island__caption")?.textContent).toBe(heard);
    }
    expect(iconRenders.count).toBe(controlsDrawn);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
