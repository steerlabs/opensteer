// @vitest-environment happy-dom
import { DeploymentIdSchema } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, layoutTextSizes } from "../../test-support/layout-phones.js";
import {
  layout,
  layoutWindow,
  textElement,
  readingColumn,
  textFaults,
} from "../../test-support/yoga-frames.js";

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
// The phone the list is drawn on: its frame decides the gutter (`deriveLayout`), its insets the
// list's padding, as the screen's own hooks read them.
const phoneNow = vi.hoisted(() => ({
  insets: { bottom: 0, left: 0, right: 0, top: 0 },
  window: { height: 0, width: 0 },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ ...phoneNow.window, x: 0, y: 0 }),
  useSafeAreaInsets: () => phoneNow.insets,
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
// The row's "…" menu is a touch-sized control beside the words: drawn as one, so the words get
// the width they have on a phone.
vi.mock("./deployment-menu.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return { DeploymentMenu: () => <View style={{ height: 44, width: 44 }} /> };
});
vi.mock("./cloud-computer-ids.js", () => ({
  useCloudComputerIds: () => new Set(),
}));
vi.mock("../threads/task-row.js", () => ({ UnreadDot: () => null }));
vi.mock("../ui/action-line.js", () => ({ ActionLine: () => null }));

const { DeploymentListRow } = await import("./deployments.js");
const { RowGroup } = await import("../ui/primitives.js");
const { useListContentInsets, useReadingColumn } = await import("../ui/screen.js");
const { space } = await import("../theme.js");
const { ScrollView, View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

/**
 * The Homes list as its screen draws it (`deployments.tsx`): a scroll view whose content keeps the
 * list's insets and reading column, the rows in a `RowGroup` (a plate, with its border). Rows
 * tested anywhere narrower or wider than this fit or break by a point or two that the app does not.
 */
function PickerList(props: { readonly children: readonly ReactNode[] }): ReactNode {
  const listInsets = useListContentInsets(space[32]);
  const column = useReadingColumn();
  return (
    <View style={{ height: phoneNow.window.height, width: phoneNow.window.width }}>
      <ScrollView
        contentContainerStyle={[{ gap: space[12], paddingTop: space[12] }, column, listInsets]}
      >
        <RowGroup>{props.children}</RowGroup>
      </ScrollView>
    </View>
  );
}

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
        Object.assign(phoneNow, { insets: phone.insets, window: phone.window });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        const none = () => undefined;
        const list: ReactNode[] = homes.map((home) => (
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
        // As the list stands on its screen: in its group, inside the gutter, clear of the bar.
        await act(async () => root.render(<PickerList>{list}</PickerList>));
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        expect(
          textFaults(frames, { column: readingColumn(phone) }),
          "a text a person reads is broken or cut",
        ).toEqual([]);
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
        Object.assign(phoneNow, { insets: phone.insets, window: phone.window });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        const none = () => undefined;
        await act(async () =>
          root.render(
            <PickerList>
              {[
                <DeploymentListRow
                  attention={null}
                  current={false}
                  onDetails={none}
                  onOpen={none}
                  onPair={none}
                  onRemove={none}
                  onSignOut={none}
                  row={{ ...row({ id: homes[0]!.id, name: "Studio Mac" }), status: "connected" }}
                />,
              ]}
            </PickerList>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        expect(
          textFaults(frames, { column: readingColumn(phone) }),
          "a text a person reads is broken or cut",
        ).toEqual([]);
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

describe("what a Home's row says", () => {
  const remoteAccessOff = "Remote access is off. Turn it on in Opensteer on that Mac.";
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`reads whole, never cut short, on ${phone.name} at text size ${fontScale}`, async () => {
        Object.assign(layoutWindow, phone.window, { fontScale });
        Object.assign(phoneNow, { insets: phone.insets, window: phone.window });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        const none = () => undefined;
        await act(async () =>
          root.render(
            <PickerList>
              {[
                <DeploymentListRow
                  // The Mac this Home lives on, by its own name, as the list's one read says.
                  attention={{ homeName: "Mac mini in the studio", needsYou: 0, unread: false }}
                  current={false}
                  onDetails={none}
                  onOpen={none}
                  onPair={none}
                  onRemove={none}
                  onSignOut={none}
                  row={{
                    ...row({ id: homes[0]!.id, name: "Studio Mac" }),
                    accountManaged: true,
                    remoteAccessOff: true,
                    status: "unavailable",
                  }}
                />,
              ]}
            </PickerList>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        expect(
          textFaults(frames, { column: readingColumn(phone) }),
          "a text a person reads is broken or cut",
        ).toEqual([]);
        for (const words of [remoteAccessOff, "Home: Mac mini in the studio"]) {
          const text = [...container.querySelectorAll('[data-rn="Text"]')].find(
            (candidate) => candidate.textContent === words,
          );
          if (!text) throw new Error(`No "${words}" in ${container.textContent ?? ""}`);
          expect(frames.shown(text), `"${words}" is cut`).toBe(words);
          expect(
            frames.frame(text).x + frames.frame(text).width,
            `"${words}" runs past the row`,
          ).toBeLessThanOrEqual(phone.window.width - phone.insets.right - 16 + 0.5);
        }
      });
});

describe("a Home that needs signing in to, as the picker showed it", () => {
  // Run 20261122T193239Z-59702488: at the largest size "computer" broke as "compu" / "ter" and
  // the sentence was cut after "Sign in to this Ope…". A word that fits the reading column but not
  // the column beside the mark and the controls; the earlier fixtures held none.
  const sentence = "Sign in to this Opensteer to see your work.";
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`reads whole on ${phone.name} at text size ${fontScale}`, async () => {
        Object.assign(layoutWindow, phone.window, { fontScale });
        Object.assign(phoneNow, { insets: phone.insets, window: phone.window });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        const none = () => undefined;
        await act(async () =>
          root.render(
            <PickerList>
              {[
                <DeploymentListRow
                  attention={null}
                  current={false}
                  onDetails={none}
                  onOpen={none}
                  onPair={none}
                  onRemove={none}
                  onSignOut={none}
                  row={{
                    ...row({ id: homes[0]!.id, name: "Messaging computer" }),
                    kindLabel: "Server",
                    status: "needs-sign-in",
                  }}
                  cloud
                />,
              ]}
            </PickerList>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        expect(
          textFaults(frames, { column: readingColumn(phone) }),
          "a text a person reads is broken or cut",
        ).toEqual([]);
        for (const words of ["Messaging computer", sentence]) {
          const text = textElement(container, words);
          expect(frames.shown(text), `"${words}" is cut`).toBe(words);
        }
      });
});

describe("a failure line above the Homes list", () => {
  const sentence = "Opensteer couldn't save your sign-in on this iPhone. Try again.";
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`reads whole on ${phone.name} at text size ${fontScale}`, async () => {
        Object.assign(layoutWindow, phone.window, { fontScale });
        Object.assign(phoneNow, { insets: phone.insets, window: phone.window });
        // The list's own line, not the stand-in the rest of this file draws nothing for.
        const { ActionLine } =
          await vi.importActual<typeof import("../ui/action-line.js")>("../ui/action-line.js");
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        const none = () => undefined;
        await act(async () =>
          root.render(
            <View
              style={{
                gap: 12,
                paddingLeft: 16 + phone.insets.left,
                paddingRight: 16 + phone.insets.right,
                width: phone.window.width,
              }}
            >
              <ActionLine
                line={{ key: "failed", text: sentence, tone: "muted" }}
                onDismiss={none}
              />
              <DeploymentListRow
                attention={null}
                current={false}
                onDetails={none}
                onOpen={none}
                onPair={none}
                onRemove={none}
                onSignOut={none}
                row={row(homes[0]!)}
              />
            </View>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        expect(
          textFaults(frames, { column: readingColumn(phone) }),
          "a text a person reads is broken or cut",
        ).toEqual([]);
        const text = textElement(container, sentence);
        expect(frames.shown(text), "the failure is cut").toBe(sentence);
        expect(
          frames.frame(text).x + frames.frame(text).width,
          "the failure runs past the screen's gutter",
        ).toBeLessThanOrEqual(phone.window.width - phone.insets.right - 16 + 0.5);
      });
});
