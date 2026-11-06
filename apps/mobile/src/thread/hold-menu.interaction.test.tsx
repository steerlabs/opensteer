// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  actions: [] as readonly { readonly id: string }[],
  closeMenu: null as (() => void) | null,
  pick: null as ((id: string) => void) | null,
  show: vi.fn(),
}));

type Accessible = {
  accessibilityActions?: readonly { readonly name: string }[];
  accessibilityLabel?: string;
  accessible?: boolean;
  children?: ReactNode;
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};

// The menus themselves are the platform's; what is ours is when they mount, what
// they are given, and that a person who cannot hold still reaches every action.
vi.mock("react-native", () => ({
  Pressable: (props: Accessible & { onLongPress?: () => void }) => (
    <button
      onClick={props.onLongPress}
      onKeyDown={() => props.onAccessibilityAction?.({ nativeEvent: { actionName: "copy" } })}
    >
      {props.children}
    </button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: (props: Accessible) => (
    <div
      aria-label={props.accessibilityLabel}
      data-actions={props.accessibilityActions?.map(({ name }) => name).join(",")}
      onClick={() => props.onAccessibilityAction?.({ nativeEvent: { actionName: "copy" } })}
    >
      {props.children}
    </div>
  ),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock("@expo/ui/community/menu", async () => {
  const { useImperativeHandle } = await vi.importActual<typeof import("react")>("react");
  return {
    MenuView: (props: {
      actions: readonly { id: string }[];
      children: ReactNode;
      onCloseMenu: () => void;
      onPressAction: (event: { nativeEvent: { event: string } }) => void;
      ref: unknown;
    }) => {
      useImperativeHandle(props.ref as never, () => ({ show: native.show }));
      native.actions = props.actions;
      native.closeMenu = props.onCloseMenu;
      native.pick = (id) => props.onPressAction({ nativeEvent: { event: id } });
      return <div data-menu>{props.children}</div>;
    },
  };
});
vi.mock("../../modules/context-menu/index.js", () => ({
  ContextMenu: (props: {
    actions: readonly { id: string }[];
    children: ReactNode;
    onAction: (event: { nativeEvent: { id: string } }) => void;
  }) => {
    native.actions = props.actions;
    native.pick = (id) => props.onAction({ nativeEvent: { id } });
    return <div data-context-menu>{props.children}</div>;
  },
}));

import { HoldMenu as AndroidHoldMenu } from "./hold-menu.js";
import { HoldMenu as IosHoldMenu } from "./hold-menu.ios.js";
import { messageActions } from "./message-actions.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  native.show.mockClear();
  native.closeMenu = null;
  native.pick = null;
});

function draw(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

const actions = messageActions({ onReply: () => undefined });

describe("holding a message on Android", () => {
  it("pays for no native menu until a bubble is held, and lets it go on close", () => {
    const onAction = vi.fn();
    const held = draw(
      <AndroidHoldMenu actions={actions} onAction={onAction} previewRadius={20}>
        Words
      </AndroidHoldMenu>,
    );
    expect(held.querySelector("[data-menu]")).toBeNull();

    act(() => held.querySelector("button")?.click());
    expect(held.querySelector("[data-menu]")).not.toBeNull();
    expect(native.show).toHaveBeenCalledOnce();

    act(() => native.pick?.("copy"));
    expect(onAction).toHaveBeenCalledWith("copy");

    act(() => native.closeMenu?.());
    expect(held.querySelector("[data-menu]")).toBeNull();
  });

  it("has no menu to open for a message with nothing to offer", () => {
    const held = draw(
      <AndroidHoldMenu actions={[]} onAction={() => undefined} previewRadius={20}>
        Words
      </AndroidHoldMenu>,
    );
    act(() => held.querySelector("button")?.click());
    expect(held.querySelector("[data-menu]")).toBeNull();
  });
});

describe("holding a message on iOS", () => {
  it("gives the system's menu every action, and answers the one picked", () => {
    const onAction = vi.fn();
    draw(
      <IosHoldMenu actions={actions} onAction={onAction} previewRadius={20}>
        Words
      </IosHoldMenu>,
    );
    expect(native.actions.map(({ id }) => id)).toEqual(actions.map(({ id }) => id));
    act(() => native.pick?.("share"));
    expect(onAction).toHaveBeenCalledWith("share");
  });

  it("puts the actions where VoiceOver can reach them, apart from the bubble's own links", () => {
    const onAction = vi.fn();
    const held = draw(
      <IosHoldMenu actions={actions} onAction={onAction} previewRadius={20}>
        <a href="https://a.co">Words</a>
      </IosHoldMenu>,
    );
    const element = held.querySelector<HTMLElement>('[aria-label="Message actions"]');
    expect(element?.dataset["actions"]).toBe(actions.map(({ id }) => id).join(","));
    expect(element?.querySelector("a")).toBeNull();
    act(() => element?.click());
    expect(onAction).toHaveBeenCalledWith("copy");
  });
});
