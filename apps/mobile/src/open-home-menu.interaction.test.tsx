// @vitest-environment happy-dom

import { createRequire } from "node:module";
import { cloudWords } from "@opensteer/client/computers";
import { DeploymentIdSchema } from "@opensteer/core";
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentRoot, deploymentsRoot } from "./navigation-state.js";
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
 *   and survives even back-to-back direct keyless resets.
 * - A root reset always dispatches when called: after a prevented reset is
 *   lifted, the next identical reset succeeds; an account change on bare Tasks
 *   mounts a fresh Home instance.
 * - On a wide window (docked sidebar), Menu is absent on first render and
 *   updates cleanly as the docked state changes.
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
  let subject: string | null = null;
  let attention = 12;
  let preventRemove = false;
  let homeMounts = 0;
  let cloudScreen: unknown = { kind: "none" };

  const notify = (): void => {
    for (const listener of Array.from(listeners)) listener();
  };

  const client = {
    cloudComputers: null,
    getSnapshot: () => ({
      account: {
        account:
          subject === null
            ? { available: true, detail: null, identity: null, status: "signed-out" }
            : {
                available: true,
                detail: null,
                identity: { issuer: "https://opensteer.example", subject },
                status: "signed-in",
              },
      },
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
    getCloudScreen: () => cloudScreen,
    getHomeMounts: () => homeMounts,
    getPreventRemove: () => preventRemove,
    incrementHomeMounts: () => {
      homeMounts += 1;
      return homeMounts;
    },
    notify,
    openSidebar: vi.fn(),
    resetState: () => {
      listeners.clear();
      selectionId = null;
      subject = null;
      attention = 12;
      preventRemove = false;
      homeMounts = 0;
      cloudScreen = { kind: "none" };
      client.openDeployment.mockClear();
      client.readAttention.mockClear();
    },
    setCloudScreen: (next: unknown) => {
      cloudScreen = next;
    },
    setPreventRemove: (next: boolean) => {
      preventRemove = next;
    },
    setSelectionId: (next: string | null) => {
      selectionId = next;
    },
    setSubject: (next: string | null) => {
      subject = next;
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
  useCloudComputer: () => ({
    act: vi.fn(),
    actionFailure: null,
    pending: null,
    refresh: vi.fn(),
    screen: harness.getCloudScreen(),
    work: [],
  }),
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
  // A phone at the default text size: rows of Your Opensteers lay out side by side.
  useWindowDimensions: () => ({ fontScale: 1, height: 844, scale: 3, width: 390 }),
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
  workHomeSections: () => [],
}));
vi.mock("./screens/native-settings-page.js", () => ({
  NativeSettingsPage: ({
    sections,
  }: {
    readonly sections: readonly {
      readonly rows: readonly {
        readonly key: string;
        readonly label: string;
        readonly onPress?: () => void;
      }[];
    }[];
  }) => (
    <div>
      {sections.flatMap((section) =>
        section.rows.map((row) =>
          row.onPress ? (
            <button aria-label={row.label} key={row.key} onClick={row.onPress} type="button">
              {row.label}
            </button>
          ) : (
            <span key={row.key}>{row.label}</span>
          ),
        ),
      )}
    </div>
  ),
}));
vi.mock("./threads/task-row.js", () => ({ UnreadDot: () => null }));

import {
  NavigationContainer,
  StackActions,
  StackRouter,
  createNavigatorFactory,
  useNavigationBuilder,
  usePreventRemove,
  type InitialState,
} from "@react-navigation/native";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { headerActions, rootScreenOptions, TopLevelMenu } from "./navigation-header.js";
import {
  navigationRef,
  reconcileRootSelection,
  resetRoot,
  resetToDeployments,
} from "./navigation-ref.js";
import { CloudComputerScreen } from "./screens/cloud-computer.js";
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
  const [instance] = useState(() => harness.incrementHomeMounts());
  return <div data-home-instance={instance}>Tasks screen</div>;
}

function ThreadStub(): ReactNode {
  return <div>Thread screen</div>;
}

function SettingsStub(): ReactNode {
  return <div>Settings screen</div>;
}

function GuardedSetupStub(): ReactNode {
  const [prevent, setPrevent] = useState(() => harness.getPreventRemove());
  useEffect(() => harness.client.subscribe(() => setPrevent(harness.getPreventRemove())), []);
  usePreventRemove(prevent, () => undefined);
  return <div>Set up this phone</div>;
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

async function mountApp(options?: {
  readonly docked?: boolean;
  readonly initialState?: InitialState;
}) {
  const initialLeadingByRoute = new Map<string, readonly NativeItem[]>();
  const latestOptionsByRoute = new Map<string, NativeStackNavigationOptions>();

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
          const routeOptions = descriptor.options as NativeStackNavigationOptions;
          const items = readLeadingItems(routeOptions);
          if (!initialLeadingByRoute.has(route.key)) {
            initialLeadingByRoute.set(route.key, items);
          }
          latestOptionsByRoute.set(route.key, routeOptions);
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

  // Mirrors app.tsx's client.subscribe(sync): account switches rebuild the root,
  // then selection reconciliation runs.
  const sync = (): void => {
    const snapshot = harness.client.getSnapshot();
    const subject = snapshot.account.account.identity?.subject ?? null;
    if (
      destinations.account(subject) &&
      navigationRef.isReady() &&
      destinations.mayReconcileSelection(snapshot.selection.deploymentId)
    ) {
      const id = snapshot.selection.deploymentId;
      resetRoot(id === null ? deploymentsRoot() : deploymentRoot(id));
    }
    observeRootSelection();
  };

  // Subscribed at app startup before the user taps a Home row, as in app.tsx.
  sync();
  cleanups.push(harness.client.subscribe(sync));
  const control = { close: vi.fn(), open: harness.openSidebar };
  sidebarRef.current = control;
  sidebarDockedRef.current = options?.docked ?? false;
  const resetRootSpy = vi.spyOn(navigationRef, "resetRoot");

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  const initialState = options?.initialState ?? { index: 0, routes: [{ name: "Deployments" }] };

  const renderTree = (docked: boolean) => (
    <SidebarControlContext.Provider value={control}>
      <SidebarDockedContext.Provider value={docked}>
        <NavigationContainer
          initialState={initialState}
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
              options: screenOptions,
            }: {
              children: ReactNode;
              options: NativeStackNavigationOptions;
            }) => {
              const modal =
                screenOptions.presentation !== undefined && screenOptions.presentation !== "card";
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
              options={({ navigation }: { navigation: { navigate: (name: string) => void } }) => ({
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
            <Stack.Screen component={ThreadStub} name="Thread" options={{ title: "Thread" }} />
            <Stack.Screen
              component={GuardedSetupStub}
              name="SetUpPhone"
              options={{ headerShown: false, title: "Set up this phone" }}
            />
            <Stack.Screen
              component={SettingsStub}
              name="Settings"
              options={{ presentation: "modal", title: "Settings" }}
            />
            <Stack.Screen
              component={CloudComputerScreen}
              name="CloudComputer"
              options={{ title: "Cloud Computer" }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SidebarDockedContext.Provider>
    </SidebarControlContext.Provider>
  );

  await act(async () => {
    root.render(renderTree(options?.docked ?? false));
  });

  const setDocked = async (docked: boolean) => {
    sidebarDockedRef.current = docked;
    await act(async () => {
      root.render(renderTree(docked));
    });
  };

  return { container, initialLeadingByRoute, latestOptionsByRoute, resetRootSpy, setDocked };
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

  it("keeps Menu on Home's first render even across back-to-back direct keyless resets in one act", async () => {
    const { container, initialLeadingByRoute } = await mountApp();

    let firstKey: string | undefined;
    let secondKey: string | undefined;
    await act(async () => {
      navigationRef.resetRoot(deploymentRoot(mockDeploymentId));
      firstKey = navigationRef.getRootState()?.routes[0]?.key;
      navigationRef.resetRoot(deploymentRoot(mockDeploymentId));
      secondKey = navigationRef.getRootState()?.routes[0]?.key;
    });

    expect(firstKey).toBeDefined();
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

  it("dispatches a later reset after a prevented reset on the same stack is lifted", async () => {
    harness.setSelectionId(mockDeploymentId);
    harness.setPreventRemove(true);
    await mountApp({ initialState: deploymentRoot(mockDeploymentId) });

    await act(async () => {
      navigationRef.dispatch(StackActions.push("SetUpPhone", { deploymentId: mockDeploymentId }));
    });
    expect(navigationRef.getRootState()?.routes.map((route) => route.name)).toEqual([
      "Home",
      "SetUpPhone",
    ]);

    await act(async () => {
      resetToDeployments();
    });
    expect(navigationRef.getRootState()?.routes.map((route) => route.name)).toEqual([
      "Home",
      "SetUpPhone",
    ]);

    await act(async () => {
      harness.setPreventRemove(false);
      harness.notify();
    });

    await act(async () => {
      resetToDeployments();
    });
    expect(navigationRef.getRootState()?.routes.map((route) => route.name)).toEqual([
      "Deployments",
    ]);
  });

  it("mounts a fresh Home instance when the account changes on bare Tasks", async () => {
    harness.setSelectionId(mockDeploymentId);
    harness.setSubject("account-a");
    const { container, resetRootSpy } = await mountApp({
      initialState: deploymentRoot(mockDeploymentId),
    });

    const initialKey = navigationRef.getRootState()?.routes[0]?.key;
    expect(initialKey).toBeDefined();
    expect(
      container.querySelector("[data-home-instance]")?.getAttribute("data-home-instance"),
    ).toBe("1");
    resetRootSpy.mockClear();

    await act(async () => {
      harness.setSubject("account-b");
      harness.notify();
    });

    expect(resetRootSpy).toHaveBeenCalledTimes(1);
    const nextKey = navigationRef.getRootState()?.routes[0]?.key;
    expect(nextKey).toBeDefined();
    expect(nextKey).not.toBe(initialKey);
    expect(harness.getHomeMounts()).toBe(2);
    expect(
      container.querySelector("[data-home-instance]")?.getAttribute("data-home-instance"),
    ).toBe("2");
  });

  it("omits Menu on a docked wide window on first render and updates as docked changes", async () => {
    harness.setSelectionId(mockDeploymentId);
    const { container, initialLeadingByRoute, latestOptionsByRoute, setDocked } = await mountApp({
      docked: true,
      initialState: deploymentRoot(mockDeploymentId),
    });

    const homeKey = navigationRef.getRootState()?.routes[0]?.key;
    expect(homeKey).toBeDefined();
    expect(initialLeadingByRoute.get(homeKey!)).toEqual([]);
    expect(latestOptionsByRoute.get(homeKey!)?.headerLeft?.({ canGoBack: false })).toBeNull();
    expect(
      container.querySelector('section[data-route="Home"] header button[aria-label^="Menu"]'),
    ).toBeNull();

    // Pushing a new screen while docked also omits Menu on its very first render.
    await act(async () => {
      navigationRef.dispatch(
        StackActions.push("Thread", { deploymentId: mockDeploymentId, threadId: "thr_1" }),
      );
    });
    const threadKey = navigationRef.getRootState()?.routes[1]?.key;
    expect(threadKey).toBeDefined();
    expect(initialLeadingByRoute.get(threadKey!)).toEqual([]);
    expect(latestOptionsByRoute.get(threadKey!)?.headerLeft?.({ canGoBack: false })).toBeNull();

    // Narrowing restores Menu; docking again removes it.
    await setDocked(false);
    expect(
      container.querySelector('section[data-route="Thread"] header button[aria-label^="Menu"]'),
    ).not.toBeNull();
    await setDocked(true);
    expect(
      container.querySelector('section[data-route="Thread"] header button[aria-label^="Menu"]'),
    ).toBeNull();
    expect(latestOptionsByRoute.get(threadKey!)?.headerLeft?.({ canGoBack: false })).toBeNull();
  });

  it("resets the root once when opening a Cloud Computer from Settings › Cloud Computer and keeps Menu on Tasks' first render", async () => {
    harness.setCloudScreen({
      kind: "ready",
      computer: {
        address: "https://cloud.opensteer.example",
        browserAddress: null,
        browserIp: { detail: "Dedicated", label: "Dedicated" },
        canDelete: false,
        canResume: false,
        canSuspend: false,
        deploymentId: mockDeploymentId,
        host: "cloud.opensteer.example",
        id: "cc_1",
        lastBackup: null,
        region: null,
        status: { label: "Running", reason: null, tone: "positive" },
      },
      plan: { line: "Opensteer Cloud Computer", name: "Opensteer Cloud Computer" },
    });
    const { container, initialLeadingByRoute, resetRootSpy } = await mountApp({
      initialState: {
        index: 2,
        routes: [{ name: "Deployments" }, { name: "Settings" }, { name: "CloudComputer" }],
      },
    });
    resetRootSpy.mockClear();

    const openButton = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${cloudWords("cloud.ready.open")}"]`,
    );
    expect(openButton, "Open button must be on Settings › Cloud Computer").not.toBeNull();

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
      "Menu must be present in Home's initial header options",
    ).toBe(true);
    expect(
      container.querySelector('section[data-route="Home"] header button[aria-label^="Menu"]'),
    ).not.toBeNull();
  });
});
