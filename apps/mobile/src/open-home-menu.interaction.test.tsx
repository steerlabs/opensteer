// @vitest-environment happy-dom

import { createRequire } from "node:module";
import { DeploymentIdSchema } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentRoot } from "./navigation-state.js";
import { PendingDestination } from "./pending-destination.js";

/*
 * Opening a Home from "Your Opensteers" (Deployments -> Home) and keeping
 * both screens' leading header controls intact:
 * - On "Your Opensteers" with no Home open, the leading control is the
 *   Settings gear (not Menu), so a person can reach Settings in one tap.
 * - Tapping a Home ("Open Mock deployment") lets both the app-level root
 *   selection observer (`reconcileRootSelection`) and `DeploymentsScreen`'s
 *   own `openSelected` observer run; the root must reset once, not twice.
 * - On the Tasks (`Home`) screen, Menu (accessibility label starting "Menu")
 *   comes from `rootScreenOptions` on Home's first render (before effects run)
 *   and survives even a forced second root reset, so an effect order or reset
 *   race cannot leave Tasks without a Menu.
 */

const mockDeploymentId = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001");

const harness = vi.hoisted(() => {
  type Listener = () => void;
  const listeners = new Set<Listener>();
  const row = {
    accountManaged: false,
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    kindLabel: "Mac",
    name: "Mock deployment",
    origin: "http://127.0.0.1",
    signIn: null,
    status: "signed-in",
    verification: null,
  } as const;
  let selectionId: string | null = null;
  let attention = 12;

  const notify = (): void => {
    for (const listener of Array.from(listeners)) listener();
  };

  const client = {
    cloudComputers: null,
    getSnapshot: () => ({
      account: { account: { available: true, detail: null, identity: null, status: "signed-out" } },
      directory: { detail: null, status: "idle", unavailable: [] },
      pendingComputer: null,
      rows: [row],
      selection: {
        deploymentId: selectionId,
        hostClient: null,
        session: null,
        status: "ready",
      },
    }),
    openDeployment: vi.fn(async (deploymentId: string) => {
      selectionId = deploymentId;
      notify();
    }),
    portalOrigin: null,
    readAttention: vi.fn(async () => ({ homeName: null, needsYou: attention, unread: false })),
    refreshDirectory: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    signInAccount: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    client,
    getAttention: () => attention,
    openSidebar: vi.fn(),
    resetState: () => {
      listeners.clear();
      selectionId = null;
      attention = 12;
      client.openDeployment.mockClear();
      client.readAttention.mockClear();
    },
  };
});

vi.mock("@react-navigation/native", async () => {
  const require = createRequire(import.meta.url);
  const core = await import(
    require.resolve("@react-navigation/core", {
      paths: [require.resolve("@react-navigation/native")],
    })
  );
  return { ...core, NavigationContainer: core.BaseNavigationContainer };
});
vi.mock("@opensteer/client/react", () => ({
  useCloudComputer: () => ({ screen: { kind: "none" } }),
  useHostSelector: () => ({ homeName: null, needsYou: 0, unread: false }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: "ios", select: <T,>(spec: { ios?: T; default?: T }) => spec.ios ?? spec.default },
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress} type="button">
      {children}
    </button>
  ),
  RefreshControl: () => null,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ui/copy-mark.js", () => ({ useCopy: () => ({ copied: false, copy: vi.fn() }) }));
vi.mock("./iphone-apps/context.js", () => ({
  useIphoneApps: () => null,
  useIphoneAppsState: () => ({ snapshot: { enrollment: null } }),
}));
vi.mock("./ui/mobile-client-context.js", () => ({
  useHostValue: () => harness.getAttention(),
  useMobileClient: () => harness.client,
  useMobileState: () => harness.client.getSnapshot(),
  useSelectedHostClient: () => null,
}));
vi.mock("./ui/action-line.js", () => ({ ActionLine: () => null }));
vi.mock("./ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: () => null,
  RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StatusDot: () => null,
}));
vi.mock("./ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("./ui/symbol.js", () => ({
  Symbol: ({ name }: { name: string }) => <span data-symbol={name} />,
}));
vi.mock("./screens/add-deployment.js", () => ({ AccountIdentityRow: () => null }));
vi.mock("./screens/deployment-menu.js", () => ({ DeploymentMenu: () => null }));
vi.mock("./screens/setup-scanner.js", () => ({ useSetupScanner: () => vi.fn() }));
vi.mock("./screens/welcome.js", () => ({ Welcome: () => <div>Welcome</div> }));
vi.mock("./screens/work-home.js", () => ({
  useCloudComputerIds: () => new Set(),
  useWorkBadges: () => new Map(),
}));
vi.mock("./threads/task-row.js", () => ({ UnreadDot: () => null }));

import {
  NavigationContainer,
  StackRouter,
  createNavigatorFactory,
  useNavigationBuilder,
} from "@react-navigation/native";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { headerActions, rootScreenOptions, TopLevelMenu } from "./navigation-header.js";
import { navigationRef, reconcileRootSelection } from "./navigation-ref.js";
import { DeploymentsScreen } from "./screens/deployments.js";
import {
  SidebarControlContext,
  SidebarDockedContext,
  sidebarDockedRef,
  sidebarRef,
} from "./sidebar/sidebar-context.js";

interface NativeItem {
  readonly accessibilityLabel?: string;
  readonly icon?: { readonly name: string; readonly type: string };
  readonly label: string;
  readonly onPress: () => void;
}

function readLeadingItems(options: NativeStackNavigationOptions): readonly NativeItem[] {
  const getter = options.unstable_headerLeftItems;
  return typeof getter === "function"
    ? (getter({ canGoBack: false }) as readonly NativeItem[])
    : [];
}

function TasksStub(): ReactNode {
  return <div>Tasks screen</div>;
}

function SettingsStub(): ReactNode {
  return <div>Settings screen</div>;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  sidebarRef.current = null;
  sidebarDockedRef.current = false;
  harness.resetState();
  harness.openSidebar.mockReset();
  vi.restoreAllMocks();
});

async function mountApp() {
  const initialLeadingByRoute = new Map<string, readonly NativeItem[]>();

  function TestStackNavigator(props: {
    readonly children: ReactNode;
    readonly screenLayout?: unknown;
    readonly screenOptions?: unknown;
  }) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(
      StackRouter as Parameters<typeof useNavigationBuilder>[0],
      {
        children: props.children,
        screenLayout: props.screenLayout as never,
        screenOptions: props.screenOptions as never,
      },
    );
    return (
      <NavigationContent>
        {state.routes.map((route) => {
          const descriptor = descriptors[route.key]!;
          const options = descriptor.options as NativeStackNavigationOptions;
          const items = readLeadingItems(options);
          if (!initialLeadingByRoute.has(route.key)) {
            initialLeadingByRoute.set(route.key, items);
          }
          return (
            <section data-route={route.name} key={route.key}>
              <header>
                {items.map((item) => (
                  <button
                    aria-label={item.accessibilityLabel ?? item.label}
                    data-icon={item.icon?.name ?? ""}
                    key={item.label}
                    onClick={item.onPress}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </header>
              {descriptor.render()}
            </section>
          );
        })}
      </NavigationContent>
    );
  }

  const Stack = createNavigatorFactory(TestStackNavigator)();

  const destinations = new PendingDestination({
    failed: () => undefined,
    present: () => undefined,
    receive: () => false,
    resolve: async () => null,
    settled: () => undefined,
  });
  destinations.hydrated();

  const observeRootSelection = (): void => {
    reconcileRootSelection({ destinations, selection: harness.client.getSnapshot().selection });
  };

  // Subscribed at app startup before the user taps a Home row, as in app.tsx.
  cleanups.push(harness.client.subscribe(observeRootSelection));
  const control = { close: vi.fn(), open: harness.openSidebar };
  sidebarRef.current = control;
  const resetRootSpy = vi.spyOn(navigationRef, "resetRoot");

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      <SidebarControlContext.Provider value={control}>
        <SidebarDockedContext.Provider value={false}>
          <NavigationContainer
            initialState={{ index: 0, routes: [{ name: "Deployments" }] }}
            onReady={() => {
              destinations.ready();
              observeRootSelection();
            }}
            onStateChange={observeRootSelection}
            ref={navigationRef}
          >
            <Stack.Navigator
              screenLayout={({
                children,
                options,
              }: {
                children: ReactNode;
                options: NativeStackNavigationOptions;
              }) => {
                const modal = options.presentation !== undefined && options.presentation !== "card";
                return (
                  <>
                    {children}
                    {modal ? null : <TopLevelMenu />}
                  </>
                );
              }}
              screenOptions={rootScreenOptions}
            >
              <Stack.Screen
                component={DeploymentsScreen}
                name="Deployments"
                options={({
                  navigation,
                }: {
                  navigation: { navigate: (name: string) => void };
                }) => ({
                  ...headerActions({
                    left: {
                      icon: "gearshape",
                      label: "Settings",
                      onPress: () => navigation.navigate("Settings"),
                    },
                    right: {
                      icon: "plus",
                      label: "Add",
                      onPress: () => undefined,
                    },
                  }),
                  title: "Your Opensteers",
                })}
              />
              <Stack.Screen component={TasksStub} name="Home" options={{ title: "Tasks" }} />
              <Stack.Screen
                component={SettingsStub}
                name="Settings"
                options={{ presentation: "modal", title: "Settings" }}
              />
            </Stack.Navigator>
          </NavigationContainer>
        </SidebarDockedContext.Provider>
      </SidebarControlContext.Provider>,
    );
  });

  return { container, initialLeadingByRoute, resetRootSpy };
}

describe("opening a Home from Your Opensteers", () => {
  it("shows the Settings gear on Your Opensteers and opens Settings in one tap", async () => {
    const { container } = await mountApp();

    const settingsGear = container.querySelector<HTMLButtonElement>(
      'section[data-route="Deployments"] header button[aria-label="Settings"]',
    );
    expect(settingsGear, "Settings gear must stay on Your Opensteers").not.toBeNull();
    expect(settingsGear?.dataset["icon"]).toBe("gearshape");
    expect(
      container.querySelector(
        'section[data-route="Deployments"] header button[aria-label^="Menu"]',
      ),
    ).toBeNull();

    await act(async () => {
      settingsGear!.click();
    });
    expect(navigationRef.getRootState()?.routes.at(-1)?.name).toBe("Settings");
  });

  it("resets the root once when tapping a Home and keeps Menu on Tasks from its first render", async () => {
    const { container, initialLeadingByRoute, resetRootSpy } = await mountApp();

    const openButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Mock deployment"]',
    );
    expect(openButton).not.toBeNull();

    await act(async () => {
      openButton!.click();
    });

    expect(harness.client.openDeployment).toHaveBeenCalledWith(mockDeploymentId);
    expect(resetRootSpy).toHaveBeenCalledTimes(1);

    const homeRoute = navigationRef.getRootState()?.routes[0];
    expect(homeRoute?.name).toBe("Home");

    const initialHomeLeading = initialLeadingByRoute.get(homeRoute!.key) ?? [];
    expect(
      initialHomeLeading.some((item) => (item.accessibilityLabel ?? item.label).startsWith("Menu")),
      "Menu must be present in Home's initial header options, not only after useLayoutEffect",
    ).toBe(true);
    act(() => {
      initialHomeLeading[0]!.onPress();
    });
    expect(harness.openSidebar).toHaveBeenCalledTimes(1);

    const menuButton = container.querySelector<HTMLButtonElement>(
      'section[data-route="Home"] header button[aria-label^="Menu"]',
    );
    expect(menuButton, "Menu button must be on the Tasks screen").not.toBeNull();
    expect(menuButton?.getAttribute("aria-label")).toBe("Menu, 12 questions need you");
    act(() => {
      menuButton!.click();
    });
    expect(harness.openSidebar).toHaveBeenCalledTimes(2);
  });

  it("keeps Menu on Home's first render even if a direct keyless reset replaces Home", async () => {
    const { container, initialLeadingByRoute } = await mountApp();

    await act(async () => {
      navigationRef.resetRoot(deploymentRoot(mockDeploymentId));
    });
    const firstKey = navigationRef.getRootState()?.routes[0]?.key;

    await act(async () => {
      navigationRef.resetRoot(deploymentRoot(mockDeploymentId));
    });
    const secondKey = navigationRef.getRootState()?.routes[0]?.key;
    expect(secondKey).toBeDefined();
    expect(secondKey).not.toBe(firstKey);

    const initialSecondLeading = initialLeadingByRoute.get(secondKey!) ?? [];
    expect(
      initialSecondLeading.some((item) =>
        (item.accessibilityLabel ?? item.label).startsWith("Menu"),
      ),
    ).toBe(true);
    expect(
      container.querySelector('section[data-route="Home"] header button[aria-label^="Menu"]'),
    ).not.toBeNull();
  });
});
