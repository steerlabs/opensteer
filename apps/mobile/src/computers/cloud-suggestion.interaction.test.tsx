// @vitest-environment happy-dom
import { cloudSuggestionStorageKey, type HomeKind } from "@opensteer/client/computers";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ items: new Map<string, string>(), navigated: [] as string[] }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.items.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.items.set(key, value),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress} type="button">
      {children}
    </button>
  ),
}));
vi.mock("../theme.js", () => ({ space: new Proxy({}, { get: () => 0 }) }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: (route: string) => store.navigated.push(route) }),
}));
const { AsleepMoment, resetCloudSuggestionForTests } = await import("./cloud-suggestion.js");
const { GateAsleepLine } = await import("../screens/gate-asleep-line.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const day = 86_400_000;
const start = Date.parse("2026-11-20T12:00:00.000Z");
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  store.items.clear();
  store.navigated.length = 0;
  resetCloudSuggestionForTests();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

async function show(node: ReactNode) {
  await act(async () => root.render(node));
  await act(async () => undefined);
}
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === label);

function moment(props: {
  readonly homeKind: HomeKind | null;
  readonly moment: string;
  readonly lineAlways?: boolean;
  readonly now?: number;
}) {
  return (
    <AsleepMoment
      homeKind={props.homeKind}
      line="Couldn’t reach MacBook Air: asleep"
      lineAlways={props.lineAlways ?? false}
      moment={props.moment}
      now={() => props.now ?? start}
      onOpenCloudComputer={() => store.navigated.push("CloudComputer")}
    />
  );
}

describe("the asleep moment on the phone", () => {
  it("shows on the gate for a Mac Home, with the link and Not now, and remembers it showed", async () => {
    await show(<GateAsleepLine deploymentId="dep_1" macHome name="Studio Mac" />);
    expect(text()).toContain(
      "Studio Mac isn’t reachable. It may be asleep or offline. Agents can’t use it until it’s back.",
    );
    await act(async () => button("Keep agents working while your Mac sleeps")?.click());
    expect(store.navigated).toEqual(["CloudComputer"]);
    expect(JSON.parse(store.items.get(cloudSuggestionStorageKey)!)).toMatchObject({
      moment: "gate:dep_1",
      dismissed: false,
    });
  });

  it("never shows on the gate of a server, a Cloud Computer or a work Home", async () => {
    await show(<GateAsleepLine deploymentId="dep_1" macHome={false} name="Opensteer" />);
    expect(text()).toBe("");
    for (const homeKind of ["server", "cloud", "work"] as const) {
      await show(moment({ homeKind, moment: `gate:${homeKind}` }));
      expect(text()).toBe("");
    }
    expect(store.items.size).toBe(0);
  });

  it("goes with Not now, and a new moment waits 14 days", async () => {
    await show(moment({ homeKind: "mac", moment: "gate:dep_1" }));
    await act(async () => button("Not now")?.click());
    expect(text()).toBe("");
    expect(JSON.parse(store.items.get(cloudSuggestionStorageKey)!)).toMatchObject({
      dismissed: true,
    });
    await show(moment({ homeKind: "mac", moment: "tool:call_2", now: start + 13 * day }));
    expect(text()).toBe("");
    await show(moment({ homeKind: "mac", moment: "tool:call_2", now: start + 14 * day }));
    expect(text()).toContain("Keep agents working while your Mac sleeps");
  });

  it("shows at most once in 14 days even without Not now", async () => {
    await show(moment({ homeKind: "mac", moment: "gate:dep_1" }));
    expect(text()).toContain("Not now");
    await show(moment({ homeKind: "mac", moment: "gate:dep_2", now: start + day }));
    expect(text()).toBe("");
    await show(moment({ homeKind: "mac", moment: "gate:dep_1", now: start + day }));
    expect(text()).toContain("Not now");
  });

  it("keeps an activity line's fact on any Home, with the link only on a Mac Home", async () => {
    await show(moment({ homeKind: "cloud", moment: "tool:call_1", lineAlways: true }));
    expect(text()).toBe("Couldn’t reach MacBook Air: asleep");
    await show(moment({ homeKind: "mac", moment: "tool:call_1", lineAlways: true }));
    expect(text()).toContain("Couldn’t reach MacBook Air: asleep");
    expect(text()).toContain("Keep agents working while your Mac sleeps");
  });
});
