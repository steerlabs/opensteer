// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MobileTeam, TeamState } from "./mobile-teams.js";

const h = vi.hoisted(() => ({
  team: null as MobileTeam | null,
  ownerId: "account-A",
  select: vi.fn(async (_id: string) => {}),
  addToPhone: vi.fn(async (_id: string) => {}),
  forget: vi.fn(async (_id: string) => {}),
  popToTop: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Children = { children?: ReactNode };
vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (s: { ios?: unknown }) => s.ios },
  View: ({ children }: Children) => <div>{children}</div>,
  ActivityIndicator: () => <span data-loading="true">Loading</span>,
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (s: object) => s },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ setOptions: vi.fn(), popToTop: h.popToTop, goBack: h.popToTop }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../thread/composer-menu.js", () => ({ NativeMenu: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
  Notice: ({ title, detail }: { title: string; detail: string }) => (
    <p>
      {title} {detail}
    </p>
  ),
  PrimaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../ui/screen.js", () => ({ Screen: ({ children }: Children) => <main>{children}</main> }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("./connection-banner.js", () => ({
  useConnectionBanner: () => null,
  ConnectionBanner: () => null,
}));
vi.mock("./team-page-list.js", () => ({ TeamPageList: () => <button>Browse channels</button> }));
vi.mock("./team-context.js", () => ({
  useMobileTeams: () => ({
    owner: { id: h.ownerId },
    select: h.select,
    addToPhone: h.addToPhone,
    forget: h.forget,
  }),
  useTeamsSnapshot: () => ({}),
  useTeamEntry: () => ({ coordinator: {} }),
  useTeamSession: () => ({
    team: h.team,
    session: h.team?.session ?? null,
    snapshot: h.team?.session?.getSnapshot() ?? {},
    failure: h.team?.detail ?? null,
  }),
}));
const { TeamHomeScreen } = await import("./team-home-screen.js");
const states: readonly TeamState[] = [
  "signed-out",
  "loading",
  "live",
  "offline",
  "update-app",
  "update-server",
  "removed",
  "join",
];
it.each([
  ...states.map((state) => ({ state, loaded: false, detail: null as string | null })),
  { state: "offline" as const, loaded: true, detail: "Offline" },
  { state: "loading" as const, loaded: false, detail: "Couldn't load" },
])(
  "presents the distinct $state recovery branch (loaded: $loaded, detail: $detail)",
  async ({ state, loaded, detail }) => {
    const snapshot = {
      bootstrap: loaded ? { can: {} } : null,
      sidebar: loaded ? { channels: [], nextCursor: null } : null,
    };
    h.team = {
      teamId: "dep_test",
      name: "Acme",
      state,
      detail,
      session: loaded ? { subscribe: () => () => {}, getSnapshot: () => snapshot } : null,
    } as unknown as MobileTeam;
    const host = document.createElement("div"),
      root = createRoot(host);
    try {
      act(() =>
        root.render(
          <TeamScreenLayout route={{ params: { teamId: "dep_test" } }}>
            <TeamHomeScreen route={{ params: { teamId: "dep_test" } }} />
          </TeamScreenLayout>,
        ),
      );
      if (loaded) expect(host.textContent).toContain("Browse channels");
      else if (state === "loading" && !detail)
        expect(host.querySelector("[data-loading]")).not.toBeNull();
      else {
        expect(host.querySelector("[data-loading]")).toBeNull();
        const label =
          state === "signed-out"
            ? "Sign in"
            : state === "offline"
              ? "Retry"
              : "Remove from this phone";
        const action = [...host.querySelectorAll("button")].find(
          (button) => button.textContent === label,
        )!;
        expect(action).toBeTruthy();
        await act(async () => action.click());
        expect(
          state === "signed-out" || state === "offline" ? h.select : h.forget,
        ).toHaveBeenCalledWith("dep_test");
      }
    } finally {
      act(() => root.unmount());
      vi.clearAllMocks();
    }
  },
);

vi.mock("expo-haptics", () => ({}));
vi.mock("../markdown/markdown.js", () => ({ Markdown: () => null }));
vi.mock("./channel-details.js", () => ({ SearchField: () => null }));
vi.mock("./knowledge-parts.js", () => ({
  useBottomPadding: () => 0,
  useFocusedRead: () => ({ value: null, failure: null }),
  Loading: () => <span data-loading="true">Loading</span>,
  knowledgeStyles: {},
}));
const { TeamNoteScreen } = await import("./knowledge-screens.js");
const { TeamScreenLayout } = await import("./team-screen-gate.js");
it("replaces a nested note's spinner with recovery after membership removal", () => {
  h.team = {
    teamId: "dep_test",
    name: "Acme",
    state: "removed",
    detail: null,
    session: null,
  } as unknown as MobileTeam;
  const host = document.createElement("div"),
    root = createRoot(host);
  const route = {
    params: {
      teamId: "dep_test",
      topicId: "ktp_00000000-0000-4000-8000-000000000001",
      noteId: "knt_00000000-0000-4000-8000-000000000001",
    },
  };
  try {
    act(() =>
      root.render(
        <TeamScreenLayout route={route}>
          <TeamNoteScreen route={route} />
        </TeamScreenLayout>,
      ),
    );
    expect(host.querySelector("[data-loading]")).toBeNull();
    expect(host.textContent).toContain("no longer in Acme");
    expect(host.textContent).toContain("Remove from this phone");
  } finally {
    act(() => root.unmount());
  }
});

it("remounts team hooks on an owner change while retaining a personal screen", () => {
  let teamMounts = 0,
    personalMounts = 0;
  function Team() {
    useState(() => ++teamMounts);
    return null;
  }
  function Personal() {
    useState(() => ++personalMounts);
    return null;
  }
  const host = document.createElement("div"),
    root = createRoot(host);
  const tree = () => (
    <>
      <TeamScreenLayout route={{ name: "CreateTeam" }}>
        <Team />
      </TeamScreenLayout>
      <TeamScreenLayout route={{ name: "Home" }}>
        <Personal />
      </TeamScreenLayout>
    </>
  );
  try {
    act(() => root.render(tree()));
    h.ownerId = "account-B";
    act(() => root.render(tree()));
    expect(teamMounts).toBe(2);
    expect(personalMounts).toBe(1);
  } finally {
    act(() => root.unmount());
    h.ownerId = "account-A";
  }
});
