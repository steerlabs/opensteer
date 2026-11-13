import { readFileSync } from "node:fs";
// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MobileTeam, TeamState } from "./mobile-teams.js";

const h = vi.hoisted(() => ({
  team: null as MobileTeam | null,
  ownerId: "account-A",
  select: vi.fn(async (_id: string) => {}),
  forget: vi.fn(async (_id: string) => {}),
  popToTop: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Children = { children?: ReactNode };
vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (s: { ios?: unknown }) => s.ios },
  Text: ({ children }: Children) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress: () => void; accessibilityLabel: string }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
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
  useMobileTeams: () => ({ owner: { id: h.ownerId }, select: h.select, forget: h.forget }),
  useTeamsSnapshot: () => ({}),
  useTeamEntry: () => ({ coordinator: {} }),
  useTeamSession: () => ({
    team: h.team,
    session: h.team?.session ?? null,
    snapshot: h.team?.session?.getSnapshot() ?? {},
    failure: h.team?.detail ?? null,
  }),
}));
vi.mock("react-native-reanimated", () => ({ default: {} }));
vi.mock("../ui/motion.js", () => ({ move: {} }));
vi.mock("../sidebar/saved-tasks.js", () => ({ SavedTasks: () => null }));
vi.mock("../browser/acting-dot.js", () => ({
  ActingDot: () => null,
  agentWorkingLabel: "Working",
}));
vi.mock("../browser/agent-surface.js", () => ({ opensteerAppGlyph: "" }));
vi.mock("../browser/site-label.js", () => ({ tabSiteLabel: () => "" }));
vi.mock("../screens/deployment-row.js", () => ({ statusTone: () => "" }));
vi.mock("../client/mobile-client.js", () => ({ operationDetail: () => "" }));
vi.mock("../threads/deployment-mark.js", () => ({ DeploymentMarkView: () => null }));
vi.mock("../threads/task-row.js", () => ({
  DraftPen: () => null,
  draftPenLabel: "Draft",
  taskTextInset: 0,
}));
vi.mock("../ui/mobile-client-context.js", () => ({}));
vi.mock("../ui/pane.js", () => ({}));
vi.mock("../ui/retained-scroll.js", () => ({}));
vi.mock("./team-marks.js", () => ({ TeamTile: () => null, MentionCount: () => null }));
const { TeamRow } = await import("../sidebar/sidebar-panel.js");
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
const cases = states.flatMap((state) =>
  (["loaded", "unloaded", "null"] as const).flatMap((session) =>
    [false, true].map((detail) => ({ state, session, detail })),
  ),
);
it.each(cases)(
  "offers recovery for $state / $session / detail=$detail",
  async ({ state, session, detail }) => {
    const snapshot = {
      bootstrap: session === "loaded" ? { can: {} } : null,
      sidebar: session === "loaded" ? { channels: [], nextCursor: null } : null,
    };
    h.team = {
      teamId: "dep_test",
      name: "Acme",
      state,
      detail: detail ? "Failure detail" : null,
      session:
        session === "null" ? null : { subscribe: () => () => {}, getSnapshot: () => snapshot },
    } as unknown as MobileTeam;
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          <TeamScreenLayout route={{ params: { teamId: "dep_test" } }}>
            <TeamHomeScreen route={{ params: { teamId: "dep_test" } }} />
          </TeamScreenLayout>,
        ),
      );
      const loading = host.querySelector("[data-loading]");
      if (loading) {
        expect(state).toBe("loading");
        expect(detail).toBe(false);
        expect(session).not.toBe("loaded");
      } else expect(host.querySelector("button")).not.toBeNull();
      act(() =>
        root.render(
          <TeamRow current={false} onOpen={(id) => void h.select(id)} team={h.team!} visible />,
        ),
      );
      const row = host.querySelector("button")!;
      expect(row.getAttribute("aria-label")).toContain("Acme");
      await act(async () => row.click());
      expect(h.select).toHaveBeenCalledWith("dep_test");
      act(() =>
        root.render(
          <TeamScreenLayout route={{ params: { teamId: "dep_test" } }}>
            <TeamHomeScreen route={{ params: { teamId: "dep_test" } }} />
          </TeamScreenLayout>,
        ),
      );
      if (state === "removed") {
        expect(host.textContent).toContain("no longer in Acme");
        const remove = [...host.querySelectorAll("button")].find(
          (b) => b.textContent === "Remove from this phone",
        )!;
        await act(async () => remove.click());
        expect(h.forget).toHaveBeenCalledWith("dep_test");
      }
      if (state === "offline" && session !== "loaded") {
        const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
        await act(async () => retry.click());
        expect(h.select).toHaveBeenCalledWith("dep_test");
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

const navigationSource = readFileSync("apps/mobile/src/navigation.tsx", "utf8");
const teamScreens = [
  ...navigationSource.matchAll(
    /(\w+):\s*\{\s*screen:\s*(?:Team\w+Screen|(?:DeleteTeam|TransferTeam|ConnectOpensteer)Screen)\b/g,
  ),
].map((match) => match[1]!);
it.each(teamScreens)("the navigator gates %s after removal", (name) => {
  expect(navigationSource).toMatch(
    /screenLayout:[\s\S]*?<TeamScreenLayout route=\{route\}>\{children\}<\/TeamScreenLayout>/,
  );
  h.team = {
    teamId: "dep_test",
    name: "Acme",
    state: "removed",
    session: null,
    detail: null,
  } as unknown as MobileTeam;
  const host = document.createElement("div"),
    root = createRoot(host);
  try {
    act(() =>
      root.render(
        <TeamScreenLayout route={{ name, params: { teamId: "dep_test" } }}>
          <span>Private team screen</span>
        </TeamScreenLayout>,
      ),
    );
    expect(host.textContent).not.toContain("Private team screen");
    expect(host.textContent).toContain("no longer in Acme");
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
