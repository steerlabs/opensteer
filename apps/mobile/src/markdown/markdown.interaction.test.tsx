// @vitest-environment happy-dom

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => undefined) }));
// A stack the screens push onto, drawn below as the destination a person would see.
const stack = vi.hoisted(() => ({
  routes: [] as { name: string; params: Record<string, unknown> }[],
  listener: () => undefined as void,
}));
const mobile = vi.hoisted(() => ({ current: null as unknown }));

// The real renderer over DOM hosts: what a phone would draw, in order and by kind.
vi.mock("react-native", () => {
  const style = (value: unknown): string => JSON.stringify(value ?? null);
  return {
    Alert: { alert: vi.fn() },
    Linking: linking,
    Platform: { OS: "ios", Version: "27.0", select: () => undefined },
    ScrollView: ({ children }: { children?: ReactNode }) => <div data-scroll>{children}</div>,
    Pressable: (props: {
      accessibilityHint?: string;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      children?: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) => (
      <span
        aria-disabled={props.disabled === true || undefined}
        aria-label={props.accessibilityLabel}
        data-hint={props.accessibilityHint}
        data-role={props.accessibilityRole}
        onClick={props.disabled ? undefined : props.onPress}
      >
        {props.children}
      </span>
    ),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: (props: {
      accessibilityRole?: string;
      children?: ReactNode;
      onPress?: () => void;
      selectable?: boolean;
      style?: unknown;
    }) => (
      <span
        data-role={props.accessibilityRole}
        data-selectable={props.selectable === true || undefined}
        data-style={style(props.style)}
        onClick={props.onPress}
      >
        {props.children}
      </span>
    ),
    View: (props: { children?: ReactNode; style?: unknown }) => (
      <div data-style={style(props.style)}>{props.children}</div>
    ),
    useWindowDimensions: () => ({ fontScale: 1, height: 800, scale: 3, width: 400 }),
  };
});
vi.mock("@react-navigation/native", () => {
  const go = (name: string, params: Record<string, unknown>) => {
    stack.routes.push({ name, params });
    stack.listener();
  };
  return {
    StackActions: {
      push: (name: string, params: Record<string, unknown>) => ({ name, params, type: "PUSH" }),
    },
    useNavigation: () => ({
      dispatch: (action: { name: string; params: Record<string, unknown> }) =>
        go(action.name, action.params),
      getState: () => ({
        index: stack.routes.length - 1,
        routes: stack.routes.map((route, index) => ({ ...route, key: String(index) })),
      }),
      goBack: () => stack.routes.pop(),
      navigate: go,
    }),
  };
});
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock("../ui/mobile-client-context.js", () => ({ useMobileClient: () => mobile.current }));
vi.mock("../ui/copy-mark.js", () => ({
  CopyMark: (props: { accessibilityLabel: string; text: string }) => (
    <button aria-label={props.accessibilityLabel} data-copies={props.text} />
  ),
}));
vi.mock("../ui/primitives.js", () => ({ monoFontFamily: "Menlo" }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../ui/symbol.js", () => ({
  Symbol: (props: { name: string }) => <i data-symbol={props.name} />,
}));

import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { RequestIdSchema } from "@opensteer/core";
import type { TeamSessionClient } from "@opensteer/client/team";
import { Markdown } from "./markdown.js";
import { PersonalReferenceProvider, TeamReferenceProvider } from "./reference-navigation.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  linking.openURL.mockClear();
  stack.routes = [];
});

function draw(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

const bold = (container: HTMLElement): readonly string[] =>
  [...container.querySelectorAll<HTMLElement>("[data-style]")]
    .filter((node) => node.dataset["style"] === '{"fontWeight":"600"}')
    .map((node) => node.textContent ?? "");

describe("Markdown on a phone", () => {
  it("reads inline text as web does, keeping what the old parser mangled", () => {
    const words = draw(
      <Markdown
        text={
          "see my_file_name.txt, 2 * 3 * 4, and \\*\\*escaped\\*\\* &amp; **[a](https://a.co)**"
        }
      />,
    );
    expect(words.textContent).toBe("see my_file_name.txt, 2 * 3 * 4, and **escaped** & a");
    expect(bold(words)).toEqual(["a"]);
  });

  it("draws bold CommonMark refuses, with what is nested in it", () => {
    const words = draw(<Markdown text={"**Note:**next and **`code`**text"} />);
    expect(bold(words)).toEqual(["Note:", "code"]);
    expect(words.textContent).toBe("Note:next and codetext");
  });

  it("draws bold still being written as bold, with no stray markers", () => {
    const words = draw(<Markdown streaming text={"Done.\n\nThis is **partial"} />);
    expect(bold(words)).toEqual(["partial"]);
    expect(words.textContent).not.toContain("**");
  });

  it("keeps a heading from swallowing the body written straight under it", () => {
    const words = draw(<Markdown text={"# Result\nIt passed."} />);
    expect(words.querySelector('[data-role="header"]')?.textContent).toBe("Result");
    expect(words.textContent).toBe("ResultIt passed.");
  });

  it("numbers a list from where its author started it, and nests one in another", () => {
    const words = draw(<Markdown text={"3. Third\n   - inner\n4. Fourth"} />);
    expect(words.textContent).toBe("3.Third•inner4.Fourth");
  });

  it("gives a list item's words the width of a bubble that sizes itself by them", () => {
    const words = draw(<Markdown look="bubble" text={"- one\n- two"} />);
    const bodies = [...words.querySelectorAll<HTMLElement>("[data-style]")].filter((node) =>
      node.dataset["style"]?.includes("flexShrink"),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.dataset["style"]).not.toContain('"flex":');
  });

  it("marks done and open tasks, and strikes out what the author struck", () => {
    const words = draw(<Markdown text={"- [x] done\n- [ ] open\n\n~~gone~~"} />);
    const marks = [...words.querySelectorAll<HTMLElement>("[data-symbol]")];
    expect(marks.map((mark) => mark.dataset["symbol"])).toEqual([
      "checkmark.circle.fill",
      "circle",
    ]);
    expect(words.textContent).toContain("gone");
    expect(words.textContent).not.toContain("~~");
  });

  it("reads a table's cells, padding a short row to the header's width", () => {
    const words = draw(<Markdown text={"| a | b |\n|---|---|\n| **1** |"} />);
    expect(words.textContent).toBe("ab1");
    expect(bold(words)).toEqual(["1"]);
  });

  it("keeps a fence that has not closed yet readable while it streams", () => {
    const words = draw(<Markdown streaming text={"```ts\nconst a = 1;"} />);
    expect(words.querySelector("button")?.dataset["copies"]).toBe("const a = 1;");
  });

  it("copies a block's own words, and names what it copies", () => {
    const words = draw(<Markdown text={"```draft\nHeads up.\n```\n\n```\nls\n```"} />);
    const marks = [...words.querySelectorAll("button")];
    expect(marks.map((mark) => mark.getAttribute("aria-label"))).toEqual([
      "Copy draft",
      "Copy code",
    ]);
    expect(marks.map((mark) => mark.dataset["copies"])).toEqual(["Heads up.", "ls"]);
  });

  it("lets a task's words be selected in place, and leaves a bubble's to its hold", () => {
    expect(draw(<Markdown text="Words" />).querySelector("[data-selectable]")).not.toBeNull();
    expect(
      draw(<Markdown look="bubble" text="Words" />).querySelector("[data-selectable]"),
    ).toBeNull();
  });
});

describe("Links an agent wrote, on a phone", () => {
  const linkIn = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('[data-role="link"]');

  it("opens a web link, and a bare address the author did not wrap", () => {
    const words = draw(<Markdown text="[docs](https://a.co/x) and https://b.co/y." />);
    act(() => linkIn(words)?.click());
    expect(linking.openURL).toHaveBeenCalledWith("https://a.co/x");
    expect(words.querySelectorAll('[data-role="link"]')).toHaveLength(2);
    expect(words.textContent).toBe("docs and https://b.co/y.");
  });

  it("opens a link written by reference, and keeps a referenced image's words", () => {
    const words = draw(
      <Markdown
        text={"[docs][ref] ![a chart][img]\n\n[ref]: https://a.co/x\n[img]: https://a.co/c.png"}
      />,
    );
    act(() => linkIn(words)?.click());
    expect(linking.openURL).toHaveBeenCalledWith("https://a.co/x");
    expect(words.textContent).toBe("docs a chart");
  });

  it.each([
    ["a local file", "/Users/person/Downloads/report.pdf"],
    ["a script", "javascript:alert(1)"],
    ["a URL carrying credentials", "https://reader:secret@example.test/private"],
  ])("keeps the words of %s and never opens it", (_name, href) => {
    const words = draw(<Markdown text={`[the words](${href})`} />);
    expect(linkIn(words)).toBeNull();
    expect(words.textContent).toBe("the words");
  });

  it("never fetches an image an agent names, and keeps its words", () => {
    const words = draw(<Markdown text="![a chart](https://a.co/chart.png)" />);
    expect(words.querySelector("img")).toBeNull();
    expect(words.textContent).toBe("a chart");
  });
});

/**
 * The phone's one attached Deployment, which a person can change at any time:
 * opening another Deployment is what a tap on an older Deployment's words asks for.
 */
function selection(deploymentId: string, hostClient: HostClient) {
  const listeners = new Set<() => void>();
  let state = { selection: { deploymentId, hostClient } };
  const select = (id: string, client: HostClient) => {
    state = { selection: { deploymentId: id, hostClient: client } };
    listeners.forEach((listener) => listener());
  };
  const client = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openDeployment: vi.fn(async (_id: string): Promise<void> => undefined),
    select,
  };
  mobile.current = client;
  return client;
}

/** What the person sees after a tap: the screen a link opened, with what it was opened for. */
function Destination(): ReactNode {
  const [, redraw] = useState(0);
  stack.listener = () => redraw((count) => count + 1);
  const top = stack.routes.at(-1);
  return top ? (
    <output>{`${top.name} ${JSON.stringify(top.params)}`}</output>
  ) : (
    <output>nothing opened</output>
  );
}

const chip = (container: HTMLElement, words: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>('[data-role="link"]')].find((node) =>
    node.getAttribute("aria-label")?.startsWith(words),
  );
  if (!found) throw new Error(`No chip reads "${words}".`);
  return found;
};
const shown = (container: HTMLElement) => container.querySelector("output")?.textContent ?? "";
/** Waits, inside React's act, for what a look-up or an open changes on screen. */
const until = (check: () => void) => act(() => vi.waitFor(check, { timeout: 2_000 }));

describe("References on a phone", () => {
  const deploymentId = "dep_00000000-0000-4000-8000-000000000001";
  const launch = RequestIdSchema.parse("req_0192f4a1-1111-4000-8000-000000000001");
  const launchThread = "thr_00000000-0000-4000-8000-000000000003";
  const storage = "thr_00000000-0000-4000-8000-000000000002";
  const gone = "thr_00000000-0000-4000-8000-0000000000ff";
  const words = [
    `Approve [the launch email](opensteer:${launch}) for [old task](opensteer:${gone}),`,
    `see [storage](opensteer:${storage}) and [notes](/Users/me/Opensteer/notes.md:42).`,
  ].join(" ");

  async function host(input: { readonly failFirst?: boolean } = {}): Promise<MockHostClient> {
    const client = new MockHostClient({
      latencyMs: 0,
      ...(input.failFirst ? { referenceResolveFailureId: launch } : {}),
    });
    await client.load();
    // Settled, the Request is no longer held: only the Host knows where it lives.
    await client.dispatch({
      idempotencyKey: "settle-launch",
      requestId: launch,
      response: { kind: "choice", optionId: "approve" },
      type: "request.respond",
    });
    return client;
  }

  it("opens what a link names at its parent, retries a failed look-up, and shows what is gone", async () => {
    const owner = await host({ failFirst: true });
    selection(deploymentId, owner);
    const container = draw(
      <PersonalReferenceProvider client={owner} deploymentId={deploymentId} threadId={null}>
        <Markdown text={words} />
        <Destination />
      </PersonalReferenceProvider>,
    );
    // Held words show their current title at once, with no look-up.
    expect(chip(container, "Review storage integration")).toBeTruthy();
    // The first look-up failed: both chips keep their words and stay tappable.
    await until(() => expect(owner.references.read(launch).state).toBe("failed"));
    expect(chip(container, "old task").getAttribute("aria-disabled")).toBeNull();

    // Asked again, the Host says one is gone: it says so, and opens nothing.
    await act(async () => chip(container, "old task").click());
    await until(() =>
      expect(chip(container, "old task").getAttribute("data-hint")).toBe("No longer available"),
    );
    act(() => chip(container, "old task").click());
    expect(shown(container)).toBe("nothing opened");

    // The other was only out of reach: a tap finds where it lives now.
    await act(async () => chip(container, "the launch email").click());
    await until(() =>
      expect(shown(container)).toBe(
        `RequestSheet ${JSON.stringify({ deploymentId, opened: "reference", requestId: launch, threadId: launchThread })}`,
      ),
    );

    await act(async () => chip(container, "notes.md").click());
    await until(() =>
      expect(shown(container)).toBe(
        `FileViewer ${JSON.stringify({ deploymentId, threadId: null, source: { kind: "path", path: "/Users/me/Opensteer/notes.md" }, line: 42 })}`,
      ),
    );
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  it("lets only the Deployment that wrote the words answer for them", async () => {
    const owner = await host();
    const other = new MockHostClient({ latencyMs: 0 });
    const resolveOther = vi.spyOn(other.references, "resolve");
    const phone = selection(deploymentId, owner);
    const container = draw(
      <PersonalReferenceProvider client={owner} deploymentId={deploymentId} threadId={null}>
        <Markdown text={words} />
        <Destination />
      </PersonalReferenceProvider>,
    );
    // The person moves to another Deployment after the words were drawn.
    act(() => phone.select("dep_00000000-0000-4000-8000-0000000000b0", other));

    // The tap opens the words' own Deployment; choosing a third meanwhile cancels it.
    let opened = () => undefined as void;
    phone.openDeployment.mockImplementationOnce(
      () => new Promise<void>((resolve) => (opened = resolve)),
    );
    act(() => chip(container, "Review storage integration").click());
    expect(phone.openDeployment).toHaveBeenLastCalledWith(deploymentId);
    act(() => phone.select("dep_00000000-0000-4000-8000-0000000000c0", other));
    await act(async () => opened());
    expect(shown(container)).toBe("nothing opened");

    // Opened again with nothing in the way, only the owner supplies the destination.
    phone.openDeployment.mockImplementationOnce(async (id: string) => phone.select(id, owner));
    await act(async () => chip(container, "Review storage integration").click());
    await until(() =>
      expect(shown(container)).toBe(
        `Thread ${JSON.stringify({ deploymentId, threadId: storage })}`,
      ),
    );
    expect(resolveOther).not.toHaveBeenCalled();
  });

  it("opens team pages through the team, and leaves a personal Opensteer's links as words", () => {
    const origin = "https://team.example.test";
    const channelId = "tch_00000000-0000-4000-8000-000000000001";
    const session = {
      getSnapshot: () => ({
        channel: null,
        sidebar: { channels: [{ channel: { id: channelId, name: "launch-room" } }] },
        thread: null,
      }),
      subscribe: () => () => undefined,
    } as unknown as TeamSessionClient;
    const container = draw(
      <TeamReferenceProvider client={session} origin={origin} teamId="dep_team">
        <Markdown
          text={`Ask in [the room](${origin}/c/${channelId}) about [my task](opensteer:${storage}) and [notes](/Users/me/Opensteer/notes.md).`}
        />
        <Destination />
      </TeamReferenceProvider>,
    );
    // The team's own session names its channel; no read is made for the chip.
    act(() => chip(container, "launch-room").click());
    expect(shown(container)).toBe(
      `JoinTeam ${JSON.stringify({ link: `${origin}/c/${channelId}` })}`,
    );
    expect(container.querySelectorAll('[data-role="link"]')).toHaveLength(1);
    expect(container.textContent).toContain("my task and notes.");
    expect(linking.openURL).not.toHaveBeenCalled();
  });
});
