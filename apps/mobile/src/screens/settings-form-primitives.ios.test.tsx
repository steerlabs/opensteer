// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@expo/ui/swift-ui", () => {
  const view =
    (name: string) =>
    ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      onPress ? (
        <button data-native={name} onClick={onPress}>
          {children}
        </button>
      ) : (
        <div data-native={name}>{children}</div>
      );
  return Object.fromEntries(
    ["Button", "Capsule", "HStack", "Image", "Spacer", "Text", "VStack"].map((name) => [
      name,
      view(name),
    ]),
  );
});
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  ...Object.fromEntries(
    [
      "accessibilityAddTraits",
      "accessibilityHidden",
      "accessibilityLabel",
      "background",
      "buttonStyle",
      "contentShape",
      "disabled",
      "font",
      "foregroundStyle",
      "frame",
    ].map((name) => [name, () => ({})]),
  ),
  shapes: new Proxy({}, { get: () => () => ({}) }),
}));
vi.mock("../theme.js", () => ({
  color: new Proxy({}, { get: () => "#000000" }),
  deploymentPaint: () => ({}),
}));

const { LineFooter } = await import("./settings-form-primitives.ios.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("puts a footer's sentence above its link, so neither is squeezed at the largest text size", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <LineFooter
          footer={{
            text: "Couldn’t read your messaging accounts.",
            link: { label: "Try again", onPress: vi.fn() },
          }}
        />,
      ),
    );
    const sentence = [...element.querySelectorAll('[data-native="Text"]')].find(
      (node) => node.textContent === "Couldn’t read your messaging accounts.",
    )!;
    expect(sentence.parentElement?.getAttribute("data-native")).toBe("VStack");
    expect(element.querySelector('[data-native="HStack"]')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
