// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ViewStyle } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  available: false,
  api: false,
  isAvailable: vi.fn(),
  isApiAvailable: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26" },
  StyleSheet: { create: (styles: object) => styles },
  View: ({ children, style }: { children: ReactNode; style: ViewStyle[] }) => (
    <div data-surface="opaque" data-style={JSON.stringify(Object.assign({}, ...style))}>
      {children}
    </div>
  ),
}));
vi.mock("expo-glass-effect", () => ({
  GlassView: ({ children }: { children: ReactNode }) => <div data-surface="glass">{children}</div>,
  isLiquidGlassAvailable: native.isAvailable,
  isGlassEffectAPIAvailable: native.isApiAvailable,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
beforeEach(() => {
  vi.resetModules();
  native.isAvailable.mockReset().mockImplementation(() => native.available);
  native.isApiAvailable.mockReset().mockImplementation(() => native.api);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

it.each([
  { available: false, api: false },
  { available: true, api: false },
])("keeps fallback opaque when availability is $available and view API is $api", async (state) => {
  Object.assign(native, state);
  const { GlassSurface } = await import("./glass.js");
  const { material, radius } = await import("../theme.js");
  const container = document.createElement("div");
  root = createRoot(container);
  act(() => {
    root!.render(
      <GlassSurface shape="capsule" style={{ backgroundColor: "transparent" }}>
        <span>Composer</span>
      </GlassSurface>,
    );
  });
  const surface = container.querySelector<HTMLElement>('[data-surface="opaque"]');
  expect(surface).not.toBeNull();
  expect(JSON.parse(surface!.dataset.style!)).toMatchObject({
    ...material.float,
    borderRadius: radius.full,
  });
  expect(container.textContent).toBe("Composer");
  if (!state.available) expect(native.isApiAvailable).not.toHaveBeenCalled();
});

it("constructs Liquid Glass only when both native guards agree, checking once per process", async () => {
  Object.assign(native, { available: true, api: true });
  const { GlassSurface } = await import("./glass.js");
  const container = document.createElement("div");
  root = createRoot(container);
  const show = () =>
    act(() =>
      root!.render(
        <GlassSurface interactive>
          <span>Composer</span>
        </GlassSurface>,
      ),
    );
  show();
  show();
  expect(container.querySelector('[data-surface="glass"]')).not.toBeNull();
  expect(native.isAvailable).toHaveBeenCalledOnce();
  expect(native.isApiAvailable).toHaveBeenCalledOnce();
});
