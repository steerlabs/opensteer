// @vitest-environment happy-dom
import { DeploymentIdSchema } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, layoutTextSizes } from "../../test-support/layout-phones.js";
import { layout, layoutWindow, textElement } from "../../test-support/yoga-frames.js";

/*
 * Two Homes in the list of Homes, laid out by React Native's own layout engine. At the largest
 * text size the walk saw both names cut to "Mock…", which tells neither from the other. Here a
 * name wraps to as many lines as it needs, so what is shown of each tells them apart.
 */

vi.mock(
  "react-native",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReactNative,
);
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: () => undefined, setOptions: () => undefined }),
  useRoute: () => ({ params: {} }),
}));
vi.mock("../ui/symbol.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Symbol: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 17, width: props.size ?? 17 }} />
    ),
  };
});
// What the list screen holds besides its rows is not what this lays out.
vi.mock("../navigation-ref.js", () => ({
  resetToDeployment: () => undefined,
  resetToDeployments: () => undefined,
}));
vi.mock("../iphone-apps/context.js", () => ({
  useIphoneApps: () => null,
  useIphoneAppsState: () => null,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({}),
  useSelectedHostClient: () => null,
}));
vi.mock("./welcome.js", () => ({ Welcome: () => null }));
vi.mock("./setup-scanner.js", () => ({ useSetupScanner: () => null }));
vi.mock("./add-deployment.js", () => ({ AccountIdentityRow: () => null }));
vi.mock("./deployment-menu.js", () => ({ DeploymentMenu: () => null }));
vi.mock("./work-home.js", () => ({
  useCloudComputerIds: () => new Set(),
  useWorkBadges: () => new Map(),
}));
vi.mock("../threads/task-row.js", () => ({ UnreadDot: () => null }));
vi.mock("../ui/action-line.js", () => ({ ActionLine: () => null }));

const { DeploymentListRow } = await import("./deployments.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const homes = [
  { id: "dep_00000000-0000-4000-8000-000000000001", name: "Mock deployment" },
  { id: "dep_00000000-0000-4000-8000-000000000002", name: "Mock deployment beside it" },
];

function row(home: (typeof homes)[number]) {
  return {
    accountManaged: false,
    deploymentId: DeploymentIdSchema.parse(home.id),
    kindLabel: "Mac",
    name: home.name,
    origin: "http://127.0.0.1",
    signIn: null,
    status: "signed-in",
    verification: null,
  } as const;
}

describe("Homes in the list", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`are told apart on ${phone.name} at text size ${fontScale}`, async () => {
        Object.assign(layoutWindow, phone.window, { fontScale });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        const none = () => undefined;
        const list: ReactNode = homes.map((home) => (
          <DeploymentListRow
            attention={null}
            current={false}
            key={home.id}
            onDetails={none}
            onOpen={none}
            onPair={none}
            onRemove={none}
            onSignOut={none}
            row={row(home)}
          />
        ));
        // As the list stands: inside the screen's gutter, clear of the vertical bar.
        await act(async () =>
          root.render(
            <View
              style={{
                paddingLeft: 16 + phone.insets.left,
                paddingRight: 16 + phone.insets.right,
                width: phone.window.width,
              }}
            >
              {list}
            </View>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        const [first, second] = homes.map((home) => {
          const name = [...container.querySelectorAll('[data-rn="Text"]')].find(
            (text) => text.textContent === home.name,
          );
          if (!name)
            throw new Error(`No ${home.name}: ${textElement(container, "Mock").textContent}`);
          return frames.shown(name);
        });
        // Each name reads whole, wrapping as it needs, so the two read differently.
        expect(first, "the first Home's name is cut").toBe(homes[0]!.name);
        expect(second, "the second Home's name is cut").toBe(homes[1]!.name);
      });
});

describe("a Home's status in the list", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`never breaks inside its word on ${phone.name} at text size ${fontScale}`, async () => {
        Object.assign(layoutWindow, phone.window, { fontScale });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        const none = () => undefined;
        await act(async () =>
          root.render(
            <View
              style={{
                paddingLeft: 16 + phone.insets.left,
                paddingRight: 16 + phone.insets.right,
                width: phone.window.width,
              }}
            >
              <DeploymentListRow
                attention={null}
                current={false}
                onDetails={none}
                onOpen={none}
                onPair={none}
                onRemove={none}
                onSignOut={none}
                row={{ ...row({ id: homes[0]!.id, name: "Studio Mac" }), status: "connected" }}
              />
            </View>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        const texts = [...container.querySelectorAll('[data-rn="Text"]')];
        const status = texts.find((text) => text.textContent === "Connected");
        const dot = texts.find((text) => text.textContent === "·");
        if (!status || !dot) throw new Error("No status line");
        // One word on one line, whole: as tall as the one-character separator beside it.
        expect(frames.shown(status)).toBe("Connected");
        // One word on one line, whole: no taller than one line of the separator's size.
        expect(
          frames.frame(status).height,
          "the status word breaks inside itself",
        ).toBeLessThanOrEqual(frames.frame(dot).height);
        const name = texts.find((text) => text.textContent === "Studio Mac")!;
        expect(frames.shown(name), "the Home's name is cut").toBe("Studio Mac");
      });
});
