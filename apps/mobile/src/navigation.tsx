import { useTeamSideBack } from "./side-back.js";
import { TeamScreenLayout } from "./team/team-screen-gate.js";
import { screenPresentations } from "./navigation-presentations.js";
import type { ReactNode } from "react";
import { SheetAnchor } from "./ui/sheet.js";
import { PersonalReferenceProvider } from "./markdown/reference-navigation.js";
import { useAttachedHostOf } from "./screens/deployment-gate.js";
import { SettingsAiSharingScreen } from "./screens/settings-ai-sharing.js";
import { isRecord } from "@opensteer/shared/isRecord";
import {
  createStaticNavigation,
  DarkTheme,
  useIsFocused,
  type Theme,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Platform } from "react-native";
import type { TabRoute } from "./browser/surface-route.js";
import type { TabId } from "@opensteer/core";
import { SetUpPhoneScreen } from "./phone-setup/setup-screen.js";
import { headerActions, stackScreenOptions, TopLevelMenu } from "./navigation-header.js";
import { isTopLevel, topLevelScreenOptions } from "./top-level.js";
import { AddDeploymentScreen } from "./screens/add-deployment.js";
import { AddPersonalScreen } from "./screens/add-personal.js";
import { AddServerScreen } from "./screens/add-server.js";
import { BrowserHistoryScreen, type BrowserHistoryDestination } from "./screens/browser-history.js";
import {
  BrowserProfilesScreen,
  type BrowserProfilesDestination,
} from "./screens/browser-profiles.js";
import { BrowserTabsScreen } from "./screens/browser-tabs.js";
import { ChromeScreen, type ChromeDestination } from "./screens/chrome.js";
import { ComputerScreen } from "./screens/computer.js";
import { DevicePageScreen } from "./screens/device-page.js";
import { ConversationActivityScreen } from "./screens/conversation-activity.js";
import { DeploymentsScreen } from "./screens/deployments.js";
import { NeedsYouScreen } from "./screens/needs-you.js";
import { HomeScreen } from "./screens/home.js";
import { NotificationsIntroScreen } from "./screens/notifications-intro.js";
import { OpenAppScreen } from "./screens/open-app.js";
import { ScheduleScreen, type ScheduleDestination } from "./screens/schedule.js";
import { SchedulesScreen } from "./screens/schedules.js";
import { YourNameScreen, type YourNameParams } from "./screens/your-name.js";
import {
  SettingsAccountScreen,
  SettingsSessionDetailScreen,
  SettingsAIScreen,
  SettingsDevicesScreen,
  SettingsGeneralScreen,
  SettingsScreen,
  SettingsSignInsScreen,
  SettingsExternalAgentsScreen,
} from "./screens/settings-home.js";
import { SettingsMessagingScreen } from "./screens/settings-messaging.js";
import { AgentAuthorizationScreen } from "./screens/agent-authorization.js";
import { SettingsPluginsScreen } from "./screens/settings-plugins.js";
import { TabsScreen } from "./screens/tabs.js";
import { AppsScreen } from "./screens/apps.js";
import { TaskSearchScreen } from "./screens/task-search.js";
import { ThreadFindScreen } from "./screens/thread-find.js";
import { RequestSheetScreen } from "./thread/request-sheet.js";
import { FileViewerScreen, type FileViewerParams } from "./thread/file-viewer.js";
import { NewThreadScreen, ThreadSettingsScreen } from "./screens/thread-settings.js";
import { RunningNowScreen } from "./screens/running-now.js";
import { SubagentScreen } from "./screens/subagent.js";
import { ThreadStepScreen } from "./screens/thread-step.js";
import { MessageHistoryScreen } from "./screens/message-history.js";
import { ThreadScreen } from "./screens/thread.js";
import type { OpeningTabRoute } from "./browser/open-tab.js";
import { OpeningTabScreen, WorkspaceBrowserScreen } from "./screens/workspace-browser.js";
import { SidebarShell } from "./sidebar/sidebar-shell.js";
import { DoneTasksScreen } from "./screens/done-tasks.js";
import {
  TeamChannelScreen,
  TeamThreadScreen,
  type TeamChannelRoute,
  type TeamThreadRoute,
} from "./team/team-channel-screens.js";
import {
  TeamDetailsScreen,
  TeamFilesScreen,
  TeamInstructionsScreen,
  TeamMembersScreen,
  TeamNoticesScreen,
  TeamPinnedScreen,
  TeamSearchScreen,
} from "./team/team-shelf-screens.js";
import {
  TeamAuditScreen,
  TeamGroupScreen,
  TeamGroupsScreen,
  TeamPeopleScreen,
  TeamSettingsScreen,
} from "./team/team-admin-screens.js";
import { TeamInvitesScreen } from "./team/invite-people-screen.js";
import { TeamPartnerSettingsScreen } from "./team/team-partner-settings.js";
import {
  CreateTeamScreen,
  DeleteTeamScreen,
  TeamSetupScreen,
  TeamsScreen,
  TransferTeamScreen,
} from "./team/team-entry-screens.js";
import { ConnectOpensteerScreen, JoinTeamScreen } from "./team/team-join-screens.js";
import {
  TeamChannelsScreen,
  TeamNewChannelScreen,
  TeamNewMessageScreen,
} from "./team/team-directory-screens.js";
import { TeamNewGroupScreen, TeamRenameChannelScreen } from "./team/team-name-forms.js";
import { TeamKnowledgeScreen, TeamNoteScreen } from "./team/knowledge-screens.js";
import { TeamTopicAccessScreen, TeamTopicFormScreen } from "./team/knowledge-forms.js";
import { color } from "./theme.js";
import { AroundScreen } from "./thread/around-sheet.js";
import { QuietlyMovedScreen } from "./threads/quietly-moved-sheet.js";
import { Pane } from "./ui/pane.js";
import { thisPhoneNoun } from "./computers/phone-noun.js";

/**
 * The whole route table, written out.
 *
 * `Thread` takes the ids a push notification carries, so a notification and a
 * tap arrive at the same screen by the same path. The header uses the platform
 * face and stays native chrome.
 *
 * Home keeps its unsent draft mounted beneath the active Tasks or team chain.
 * The sidebar resumes each side; explicit entries replace only that side.
 *
 * The drawer is the stack's own `layout` (`SidebarShell`): one navigator, one
 * history, with the drawer or docked column around it.
 *
 * The back control shows its chevron and no word, and list roots carry the
 * platform's large title; a thread's title is the person's words and keeps the
 * bar-height title that truncates gracefully.
 */
function ScreenLayout(props: {
  readonly children: ReactNode;
  readonly modal: boolean;
  readonly route: { readonly params?: unknown };
}) {
  const focused = useIsFocused();
  useTeamSideBack();
  const content = <RouteReferences route={props.route}>{props.children}</RouteReferences>;
  return (
    <>
      {props.modal ? <Pane>{content}</Pane> : content}
      {props.modal ? null : <TopLevelMenu />}
      <SheetAnchor active={focused} level={1} />
    </>
  );
}

/**
 * A personal Deployment's screen reads its links as that Deployment's: the
 * route names the owner, so a link drawn here never asks the selection whose
 * it is. A team's screens get their own context from the team's gate.
 */
function RouteReferences(props: {
  readonly children: ReactNode;
  readonly route: { readonly params?: unknown };
}): ReactNode {
  const params = isRecord(props.route.params) ? props.route.params : {};
  const deploymentId = typeof params["deploymentId"] === "string" ? params["deploymentId"] : null;
  const threadId = typeof params["threadId"] === "string" ? params["threadId"] : null;
  const client = useAttachedHostOf(deploymentId);
  if (deploymentId === null || client === null || "teamId" in params) return props.children;
  return (
    <PersonalReferenceProvider client={client} deploymentId={deploymentId} threadId={threadId}>
      {props.children}
    </PersonalReferenceProvider>
  );
}

const RootStack = createNativeStackNavigator({
  layout: ({ children, navigation, state }) => (
    <SidebarShell navigation={navigation} state={state}>
      {children}
    </SidebarShell>
  ),
  // A sheet or modal is presented away from the screens: its safe area is
  // where it was presented, not the stack's or the sidebar's beside it, and no
  // region the shell measured lies over it.
  screenLayout: ({ children, options, route }) => (
    <ScreenLayout
      modal={options.presentation !== undefined && options.presentation !== "card"}
      route={route}
    >
      <TeamScreenLayout route={route}>{children}</TeamScreenLayout>
    </ScreenLayout>
  ),
  // Recomputed as the stack changes, so a top-level screen's transition is in
  // force as it is pushed, and its pop fades the same way back to Home.
  screenOptions: ({ navigation, route }) =>
    isTopLevel(navigation.getState(), route.key)
      ? { ...stackScreenOptions, ...topLevelScreenOptions }
      : stackScreenOptions,
  screens: {
    Deployments: {
      screen: DeploymentsScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          left: {
            icon: "gearshape",
            label: "Settings",
            onPress: () => navigation.navigate("Settings"),
          },
          right: {
            icon: "plus",
            label: "Add",
            onPress: () => navigation.navigate("AddDeployment"),
          },
        }),
        headerLargeTitle: true,
        title: "Computers",
      }),
    },
    // Home: the new-task composer, holding its one unsent draft.
    // The root every top-level screen of a Deployment stands on.
    Home: { screen: HomeScreen, options: { title: "Tasks" } },
    NeedsYou: { screen: NeedsYouScreen, options: { title: "Needs you" } },
    // Every task in Done, newest Done first, from the last line of the drawer's Tasks.
    DoneTasks: { screen: DoneTasksScreen, options: { headerLargeTitle: true, title: "Done" } },
    // The tasks just moved to Done for the reader, from "+N" on that line.
    QuietlyMoved: {
      screen: QuietlyMovedScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.QuietlyMoved,
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Moved to Done for you",
      },
    },
    // Every tab this person may see, from the sidebar. A tab opened from here
    // is shown alone.
    Tabs: { screen: TabsScreen, options: { headerLargeTitle: true, title: "Tabs" } },
    // The person's published apps, from the sidebar like Tabs.
    Apps: { screen: AppsScreen, options: { headerLargeTitle: true, title: "Apps" } },
    // Everything set to run on its own, from the sidebar like Tabs.
    Schedules: {
      screen: SchedulesScreen,
      options: { headerLargeTitle: true, title: "Automations" },
    },
    // One schedule, from Schedules or a thread's Around sheet. Its name is
    // the large title, set once it loads.
    Schedule: { screen: ScheduleScreen, options: { headerLargeTitle: true, title: "" } },
    // A task just started from Home is top-level, so it fades in where New
    // task was, the composer where it was.
    Thread: { screen: ThreadScreen, options: { title: "Thread" } },
    // A subagent's own read-only conversation, pushed over the one that started
    // it; its own header names it, and Back returns to the parent.
    Subagent: { screen: SubagentScreen, options: { title: "Subagent" } },
    // A task before it exists: the first message makes it, then the task's
    // own screen replaces this one.
    // Every task on the Deployment, narrowed by the search field in its bar,
    // from the sidebar's magnifying glass.
    TaskSearch: { screen: TaskSearchScreen, options: { title: "Search" } },
    // Exactly one tab of any kind, by its tabId, from Tabs, the sidebar or a
    // conversation. The native Back (and swipe, and Android's back) returns,
    // and leaving stops nothing.
    OpeningTab: { screen: OpeningTabScreen, options: { title: "Opening…" } },
    WorkspaceBrowser: { screen: WorkspaceBrowserScreen, options: { title: "Tabs" } },
    // The one tab list, from the tab button in a page's bar, with that page
    // marked. It opens at half height and grows for many.
    BrowserTabs: {
      screen: BrowserTabsScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.BrowserTabs,
        sheetAllowedDetents: [0.5, 0.95],
        sheetGrabberVisible: true,
        title: "Tabs",
      },
    },
    // The person's own Mac apps and Agent Phones to open, from Tabs. It lists
    // by computer and opens over the screen it came from.
    OpenApp: {
      screen: OpenAppScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.OpenApp,
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Open",
      },
    },
    // The model picker starts compact and can expand for a long catalog. It
    // draws its own bar as the list's header: Android's form sheet has no
    // native header, and the list must be the sheet's direct child for iOS to
    // size it, so one in-content bar serves both platforms.
    ThreadSettings: {
      screen: ThreadSettingsScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.ThreadSettings,
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Model",
      },
    },
    // Find in conversation. It opens part-way so the conversation it searches
    // stays in view, and a result returns to it at the message it names.
    ThreadFind: {
      screen: ThreadFindScreen,
      options: ({ navigation }) => ({
        ...headerActions({ right: { label: "Done", onPress: () => navigation.goBack() } }),
        presentation: screenPresentations.ThreadFind,
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Find",
      }),
    },
    NewThread: {
      screen: NewThreadScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.NewThread,
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Choose AI",
      },
    },
    // What a Request asks, when it's too much for its card. It opens part-way so
    // the Thread it belongs to stays in view; a long approval pins its answers
    // under its list, and only a single height keeps a pin where it was put.
    RequestSheet: {
      screen: RequestSheetScreen,
      options: ({ route }) => ({
        headerShown: false,
        presentation: screenPresentations.RequestSheet,
        sheetAllowedDetents:
          isRecord(route.params) && route.params["full"] === true ? [0.95] : [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Request",
      }),
    },
    // A file a link named: its lines, its image or its download, over everything,
    // with its own bar. Close returns to the words that named it.
    FileViewer: {
      screen: FileViewerScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.FileViewer,
        title: "File",
      },
    },
    // One step of an agent's work. Its own content names it, so the sheet has
    // no bar; it opens part-way so the transcript it came from stays in view.
    ThreadStep: {
      screen: ThreadStepScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.ThreadStep,
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Step",
      },
    },
    // Run details: what one of Opensteer's replies did on the way to it,
    // opened from the reply's menu or the reply under way. Like a step it names
    // itself and opens part-way, so the conversation it belongs to stays in view.
    ConversationActivity: {
      screen: ConversationActivityScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.ConversationActivity,
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Run details",
      },
    },
    // Around this thread: the places, tasks and schedules around a
    // conversation, from its bar. It names itself and opens part-way, so the
    // conversation stays in view; a row opens over the conversation.
    ThreadAround: {
      screen: AroundScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.ThreadAround,
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Around this thread",
      },
    },
    // Every version of a message edited while it waited, from its "Edited"
    // mark. It is as tall as its versions, so the conversation stays in view.
    MessageHistory: {
      screen: MessageHistoryScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.MessageHistory,
        sheetAllowedDetents: "fitToContents",
        sheetGrabberVisible: true,
        title: "Edit history",
      },
    },
    // Running now: what works for a conversation at this moment, from the
    // capsule over its composer. It opens part-way so the conversation stays
    // in view; a row opens over the conversation.
    RunningNow: {
      screen: RunningNowScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.RunningNow,
        sheetAllowedDetents: [0.5, 0.95],
        sheetGrabberVisible: true,
        title: "Running now",
      },
    },
    // A long list opens full height like the pages it leads to: a half-height
    // detent would spend the first scroll on growing the sheet, and the next
    // on dragging it back down.
    SettingsAiSharing: {
      screen: SettingsAiSharingScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        title: "AI sharing",
      }),
    },
    SettingsGeneral: { screen: SettingsGeneralScreen, options: { title: "General" } },
    // A team's channel or DM, and a thread under one of its messages. Each is
    // keyed by the team it belongs to, never by the personal Deployment.
    TeamChannel: { screen: TeamChannelScreen, options: { title: "" } },
    TeamThread: { screen: TeamThreadScreen, options: { title: "Thread" } },
    // On a phone a channel's tabs are rows in its Details.
    TeamDetails: { screen: TeamDetailsScreen, options: { title: "Details" } },
    TeamMembers: { screen: TeamMembersScreen, options: { title: "Members" } },
    TeamRenameChannel: { screen: TeamRenameChannelScreen, options: { title: "Rename channel" } },
    TeamInstructions: {
      screen: TeamInstructionsScreen,
      options: { title: "Instructions for agents" },
    },
    TeamFiles: { screen: TeamFilesScreen, options: { title: "Files" } },
    TeamPinned: { screen: TeamPinnedScreen, options: { title: "Pinned" } },
    // A team's knowledge: notes by topic, one note with its versions, and the topics' lists.
    TeamKnowledge: { screen: TeamKnowledgeScreen, options: { title: "Knowledge" } },
    TeamTopicForm: { screen: TeamTopicFormScreen, options: { title: "New topic" } },
    TeamTopicAccess: { screen: TeamTopicAccessScreen, options: { title: "Access" } },
    TeamNote: { screen: TeamNoteScreen, options: { title: "" } },
    TeamSearch: { screen: TeamSearchScreen, options: { title: "Search" } },
    TeamNotices: { screen: TeamNoticesScreen, options: { title: "Notices" } },
    // A team's own settings group, from its section's menu or Settings.
    TeamSettings: { screen: TeamSettingsScreen, options: { title: "Team" } },
    TeamPeople: { screen: TeamPeopleScreen, options: { title: "People" } },
    TeamGroups: { screen: TeamGroupsScreen, options: { title: "Groups" } },
    TeamGroup: { screen: TeamGroupScreen, options: { title: "Group" } },
    TeamNewGroup: { screen: TeamNewGroupScreen, options: { title: "New group" } },
    TeamInvites: { screen: TeamInvitesScreen, options: { title: "Invite people" } },
    TeamPartners: { screen: TeamPartnerSettingsScreen, options: { title: "Partner teams" } },
    // Create a team or join with an invite, from the drawer and Settings.
    Teams: { screen: TeamsScreen, options: { headerLargeTitle: true, title: "Teams" } },
    CreateTeam: {
      screen: CreateTeamScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.CreateTeam,
        sheetAllowedDetents: [0.95],
        sheetGrabberVisible: true,
        title: "Create a team",
      },
    },
    // A hosted team being set up; swiping it away is Keep working.
    TeamSetup: {
      screen: TeamSetupScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.TeamSetup,
        sheetAllowedDetents: "fitToContents",
        sheetGrabberVisible: true,
        title: "Setting up your team",
      },
    },
    DeleteTeam: {
      screen: DeleteTeamScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.DeleteTeam,
        sheetAllowedDetents: [0.95],
        sheetGrabberVisible: true,
        title: "Delete team",
      },
    },
    TransferTeam: {
      screen: TransferTeamScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.TransferTeam,
        sheetAllowedDetents: "fitToContents",
        sheetGrabberVisible: true,
        title: "Transfer team",
      },
    },
    TeamChannels: { screen: TeamChannelsScreen, options: { title: "Channels" } },
    // Making a channel or starting a message: sheets over the team, their action in the bar.
    TeamNewChannel: {
      screen: TeamNewChannelScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.TeamNewChannel,
        sheetAllowedDetents: [0.95],
        sheetGrabberVisible: true,
        title: "New channel",
      },
    },
    TeamNewMessage: {
      screen: TeamNewMessageScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.TeamNewMessage,
        sheetAllowedDetents: [0.95],
        sheetGrabberVisible: true,
        title: "New message",
      },
    },
    TeamAudit: { screen: TeamAuditScreen, options: { title: "Audit log" } },
    // Joining from a link, a pasted link or a notification: a sheet over Home.
    JoinTeam: {
      screen: JoinTeamScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.JoinTeam,
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Join a team",
      },
    },
    // What Ask my agent opens when no Opensteer of the reader's is linked.
    ConnectOpensteer: {
      screen: ConnectOpensteerScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.ConnectOpensteer,
        sheetAllowedDetents: "fitToContents",
        sheetGrabberVisible: true,
        title: "Connect your Opensteer",
      },
    },
    SettingsAccount: { screen: SettingsAccountScreen, options: { title: "Account" } },
    YourName: { screen: YourNameScreen, options: { title: "Your name" } },
    SettingsSessionDetail: {
      screen: SettingsSessionDetailScreen,
      options: { title: "Signed-in device" },
    },
    SettingsDevices: { screen: SettingsDevicesScreen, options: { title: "Devices" } },
    SettingsMessaging: { screen: SettingsMessagingScreen, options: { title: "Messaging" } },
    SettingsExternalAgents: {
      screen: SettingsExternalAgentsScreen,
      options: { title: "External agents" },
    },
    SettingsAI: { screen: SettingsAIScreen, options: { title: "AI" } },
    SettingsPlugins: {
      screen: SettingsPluginsScreen,
      options: { title: "Plugins", headerShown: Platform.OS !== "ios" },
    },
    SettingsPluginDetail: { screen: SettingsPluginsScreen, options: { title: "Plugin" } },
    SettingsDeviceDetail: { screen: DevicePageScreen, options: { title: "Device" } },
    SettingsSignIns: { screen: SettingsSignInsScreen, options: { title: "Sign-ins" } },
    Settings: {
      screen: SettingsScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        presentation: screenPresentations.Settings,
        title: "Settings",
      }),
    },
    // One computer, titled with its name once it loads. It is a modal like the
    // switcher because it is reached from over other work — Settings, or a
    // Thread using the Mac — and closing it puts that work back as it was.
    Chrome: {
      screen: ChromeScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        presentation: screenPresentations.Chrome,
        title: "Chrome",
      }),
    },
    BrowserHistory: {
      screen: BrowserHistoryScreen,
      options: { title: "Browsing history" },
    },
    BrowserProfiles: {
      screen: BrowserProfilesScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        presentation: screenPresentations.BrowserProfiles,
        title: "Browser profiles",
      }),
    },
    // The accounts agents use, a modal over Settings like Chrome: a sign-in it
    // starts finishes in the system browser sheet and returns here.
    ConnectedApps: {
      screen: SettingsPluginsScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        presentation: screenPresentations.ConnectedApps,
        headerShown: Platform.OS !== "ios",
        title: "Plugins",
      }),
    },
    // Plugins, a modal over Settings like Connections.
    Plugins: {
      screen: SettingsPluginsScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        presentation: screenPresentations.Plugins,
        headerShown: Platform.OS !== "ios",
        title: "Plugins",
      }),
    },
    Computer: {
      screen: ComputerScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        presentation: screenPresentations.Computer,
        title: "Computer",
      }),
    },
    // An agent's connection request, from the link its sign-in page opens on
    // this phone. Leaving it answers nothing; the request expires on its own.
    AgentAuthorization: {
      screen: AgentAuthorizationScreen,
      options: ({ navigation }) => ({
        ...headerActions({ left: { label: "Cancel", onPress: () => navigation.goBack() } }),
        presentation: screenPresentations.AgentAuthorization,
        title: "Connect an agent",
      }),
    },
    SetUpPhone: {
      screen: SetUpPhoneScreen,
      options: {
        gestureEnabled: false,
        headerShown: false,
        title: `Set up this ${thisPhoneNoun}`,
      },
    },
    // Asked once, over Home, the first time this phone reaches a computer. It
    // sizes to its content and is dismissed like any sheet.
    NotificationsIntro: {
      screen: NotificationsIntroScreen,
      options: {
        headerShown: false,
        presentation: screenPresentations.NotificationsIntro,
        sheetAllowedDetents: "fitToContents",
        sheetGrabberVisible: true,
        title: "Notifications",
      },
    },
    DeploymentSwitcher: {
      screen: DeploymentsScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          left: { icon: "xmark", label: "Close", onPress: () => navigation.goBack() },
          right: {
            icon: "plus",
            label: "Add",
            onPress: () => navigation.navigate("AddDeployment"),
          },
        }),
        presentation: screenPresentations.DeploymentSwitcher,
        title: "Switch deployment",
      }),
    },
  },
  groups: {
    // Adding a deployment is a task with an end, not a place in the app, so
    // every step of it arrives as a sheet and every step can be left. A sheet
    // has no back chevron of its own, so each one carries the way out it needs.
    Add: {
      screenOptions: {
        presentation: screenPresentations.Add,
      },
      screens: {
        AddDeployment: {
          screen: AddDeploymentScreen,
          options: ({ navigation }) => ({
            ...headerActions({ left: { label: "Close", onPress: () => navigation.goBack() } }),
            title: "Add a deployment",
          }),
        },
        AddServer: {
          screen: AddServerScreen,
          options: ({ navigation }) => ({
            ...headerActions({ left: { label: "Back", onPress: () => navigation.goBack() } }),
            title: "Server",
          }),
        },
        // Opened from the first run, an address, a scanned code or a pairing
        // link, and often as the only sheet: its way out is Cancel, not Back.
        AddPersonal: {
          screen: AddPersonalScreen,
          options: ({ navigation }) => ({
            ...headerActions({ left: { label: "Cancel", onPress: () => navigation.goBack() } }),
            title: "Computer",
          }),
        },
      },
    },
  },
});

type OpensteerRootParamList = {
  readonly TeamChannel: TeamChannelRoute;
  readonly TeamThread: TeamThreadRoute;
  readonly TeamDetails: { readonly teamId: string; readonly channelId: string };
  readonly TeamMembers: { readonly teamId: string; readonly channelId: string };
  readonly TeamRenameChannel: { readonly teamId: string; readonly channelId: string };
  readonly TeamInstructions: { readonly teamId: string; readonly channelId: string };
  readonly TeamFiles: { readonly teamId: string; readonly channelId: string };
  readonly TeamPinned: { readonly teamId: string; readonly channelId: string };
  readonly TeamKnowledge: { readonly teamId: string; readonly topicId?: string | undefined };
  /** A new topic, or the named one's name and description. */
  readonly TeamTopicForm: { readonly teamId: string; readonly topicId?: string | undefined };
  readonly TeamTopicAccess: { readonly teamId: string; readonly topicId: string };
  readonly TeamNote: { readonly teamId: string; readonly topicId: string; readonly noteId: string };
  readonly TeamSearch: { readonly teamId: string; readonly channelId?: string | undefined };
  readonly TeamNotices: { readonly teamId: string };
  readonly TeamSettings: { readonly teamId: string };
  readonly TeamPeople: { readonly teamId: string };
  readonly TeamGroups: { readonly teamId: string };
  readonly TeamGroup: { readonly teamId: string; readonly groupId: string };
  readonly TeamNewGroup: { readonly teamId: string };
  readonly TeamInvites: { readonly teamId: string };
  readonly TeamPartners: { readonly teamId: string };
  readonly Teams: undefined;
  readonly CreateTeam: undefined;
  readonly TeamSetup: { readonly hostedTeamId: string };
  readonly DeleteTeam: { readonly teamId: string };
  readonly TransferTeam: { readonly teamId: string };
  readonly TeamChannels: { readonly teamId: string };
  /** `name` is what the person searched Browse for and didn't find. */
  readonly TeamNewChannel: { readonly teamId: string; readonly name?: string | undefined };
  readonly TeamNewMessage: { readonly teamId: string };
  readonly TeamAudit: { readonly teamId: string };
  /** A team page link the person opened or pasted, or none for the paste field. */
  readonly JoinTeam: { readonly link?: string | undefined } | undefined;
  readonly ConnectOpensteer: { readonly teamId: string };
  readonly DoneTasks: { readonly deploymentId: string };
  readonly QuietlyMoved: { readonly deploymentId: string };
  readonly AddDeployment: undefined;
  readonly SetUpPhone: { readonly deploymentId: string };
  readonly AgentAuthorization: { readonly deploymentId: string; readonly requestId: string };
  /** A pairing link or scanned code fills the form; the person still confirms it. */
  readonly AddPersonal:
    | {
        readonly code?: string | undefined;
        readonly origin?: string | undefined;
      }
    | undefined;
  readonly AddServer: undefined;
  readonly Chrome: ChromeDestination;
  readonly BrowserProfiles: BrowserProfilesDestination;
  readonly BrowserHistory: BrowserHistoryDestination;
  readonly ConnectedApps: { readonly deploymentId: string };
  readonly Computer: { readonly deploymentId: string; readonly machineId: string };
  readonly ConversationActivity: {
    readonly deploymentId: string;
    readonly threadId: string;
    /** The reply's turn, by its key. Absent, the reply under way or else the latest. */
    readonly turnKey?: string | undefined;
    /** A Run a link named, found once the transcript around its first message is loaded. */
    readonly runId?: string | undefined;
    readonly anchorMessageId?: string | undefined;
  };
  readonly FileViewer: FileViewerParams;
  readonly Deployments: undefined;
  readonly DeploymentSwitcher: undefined;
  readonly Home: { readonly deploymentId: string };
  readonly NotificationsIntro: undefined;
  readonly NewThread: {
    readonly deploymentId: string;
    /** The first-message Send that opened this picker, if any. */
    readonly pickerAttemptId?: string;
  };
  readonly OpenApp: { readonly deploymentId: string };
  readonly Schedule: ScheduleDestination;
  readonly Schedules: { readonly deploymentId: string };
  readonly SettingsAiSharing: undefined;
  readonly SettingsGeneral: { readonly deploymentId: string };
  readonly SettingsAccount: { readonly deploymentId: string };
  readonly YourName: YourNameParams;
  readonly SettingsSessionDetail: { readonly deploymentId: string; readonly sessionId: string };
  readonly SettingsDevices: { readonly deploymentId: string };
  readonly SettingsMessaging: { readonly deploymentId: string };
  readonly SettingsExternalAgents: { readonly deploymentId: string };
  readonly SettingsAI: { readonly deploymentId: string };
  readonly SettingsPlugins: { readonly deploymentId: string };
  readonly SettingsPluginDetail: {
    readonly deploymentId: string;
    readonly target: import("@opensteer/protocol").PluginTarget;
  };
  readonly SettingsDeviceDetail: { readonly deploymentId: string; readonly machineId: string };
  readonly SettingsSignIns: { readonly deploymentId: string };
  readonly Settings: undefined;
  readonly Plugins: { readonly deploymentId: string };
  readonly Tabs: { readonly deploymentId: string };
  readonly Apps: { readonly deploymentId: string };
  readonly TaskSearch: { readonly deploymentId: string };
  readonly Thread: {
    readonly deploymentId: string;
    /**
     * The exact update to open at, when a notification or link named one. It is
     * cleared once the reader leaves the window it opened, so the same id can
     * be jumped to again.
     */
    readonly messageId?: string | undefined;
    readonly requestId?: string;
    readonly threadId: string;
  };
  readonly ThreadAround: {
    readonly deploymentId: string;
    /** The page to open on, when the reader came for it. */
    readonly section?: import("./thread/around-model.js").AroundSection;
    readonly threadId: string;
  };
  readonly RunningNow: { readonly deploymentId: string; readonly threadId: string };
  readonly MessageHistory: {
    readonly deploymentId: string;
    readonly messageId: string;
    readonly threadId: string;
  };
  readonly Subagent: {
    readonly deploymentId: string;
    readonly nodeId: string;
    readonly threadId: string;
  };
  readonly RequestSheet: {
    readonly deploymentId: string;
    /** Opened from a link: a settled Request is shown as it ended rather than closed. */
    readonly opened?: "reference";
    readonly full?: boolean;
    readonly reason?: boolean;
    readonly requestId: string;
    readonly threadId: string;
  };
  readonly ThreadFind: { readonly deploymentId: string; readonly threadId: string };
  readonly ThreadSettings: { readonly deploymentId: string; readonly threadId: string };
  readonly ThreadStep: {
    readonly deploymentId: string;
    readonly entryId: string;
    /** A subagent's step, read from that subagent's own steps rather than the conversation's. */
    readonly nodeId?: string;
    readonly threadId: string;
  };
  readonly OpeningTab: OpeningTabRoute;
  readonly WorkspaceBrowser: TabRoute;
  readonly BrowserTabs: {
    readonly deploymentId: string;
    readonly tabId: TabId;
    readonly threadId?: string;
  };
};

export type RootParamList = OpensteerRootParamList;

declare global {
  namespace ReactNavigation {
    interface RootParamList extends OpensteerRootParamList {}
  }
}

/** The product's own ground, so no navigator ever paints a default grey. */
export const navigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: color.background,
    border: color.line,
    card: color.background,
    notification: color.ember,
    primary: color.ember,
    text: color.text,
  },
};

export const Navigation = createStaticNavigation(RootStack);
