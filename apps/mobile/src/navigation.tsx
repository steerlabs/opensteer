import { CHAT_THREAD_TITLE, type BrowserPageContentPart } from "@opensteer/core";
import { isRecord } from "@opensteer/shared/isRecord";
import { createStaticNavigation, DarkTheme, type Theme } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import type { ThreadDraftQuote } from "./client/thread-drafts.js";
import { headerActions, stackScreenOptions } from "./navigation-header.js";
import { AddDeploymentScreen } from "./screens/add-deployment.js";
import { AddPersonalScreen } from "./screens/add-personal.js";
import { AddServerScreen } from "./screens/add-server.js";
import {
  BrowserProfilesScreen,
  type BrowserProfilesDestination,
} from "./screens/browser-profiles.js";
import { BrowserHistoryScreen, type BrowserHistoryDestination } from "./screens/browser-history.js";
import { ChromeScreen, type ChromeDestination } from "./screens/chrome.js";
import { ConnectedAppsScreen, type ConnectedAppsDestination } from "./screens/connected-apps.js";
import type { SurfacesRoute } from "./browser/surface-route.js";
import { AddIphoneScreen } from "./iphone-apps/add-iphone.js";
import { ComputerScreen } from "./screens/computer.js";
import { ConversationActivityScreen } from "./screens/conversation-activity.js";
import { WorkspaceBrowserScreen } from "./screens/workspace-browser.js";
import { DeploymentsScreen } from "./screens/deployments.js";
import { NewSpecialistScreen } from "./screens/new-specialist.js";
import { NewTaskScreen } from "./screens/new-task.js";
import { ScheduleScreen, type ScheduleDestination } from "./screens/schedule.js";
import { SchedulesScreen } from "./screens/schedules.js";
import { SettingsScreen } from "./screens/settings.js";
import { SpecialistScreen } from "./screens/specialist.js";
import { SpecialistsScreen } from "./screens/specialists.js";
import { TabsScreen } from "./screens/tabs.js";
import { TaskSearchScreen } from "./screens/task-search.js";
import { ThreadScreen } from "./screens/thread.js";
import { ThreadFindScreen } from "./screens/thread-find.js";
import { HomeScreen } from "./screens/home.js";
import { NewThreadScreen, ThreadSettingsScreen } from "./screens/thread-settings.js";
import { ThreadStepScreen } from "./screens/thread-step.js";
import { AroundScreen } from "./thread/around-sheet.js";
import { SidebarShell } from "./sidebar/sidebar-shell.js";
import { Pane } from "./ui/pane.js";
import { color } from "./theme.js";

/**
 * The whole route table, written out.
 *
 * These routes do not justify filesystem routing, and writing them here keeps
 * the thing that matters visible: `Thread` takes the ids a push notification
 * carries, so a notification and a tap arrive at the same screen by the same
 * path. The header uses the platform face and stays native chrome.
 *
 * Chat (`Home`) is the root of every Deployment's stack and stays mounted
 * under everything pushed over it. Specialists, Tabs and Schedules are the
 * sidebar's other destinations: each is pushed over Chat with the Menu in place of
 * Back, and choosing Chat from the sidebar returns to it, so the stack never
 * grows by moving around the sidebar. Everything else — a task, search, a specialist, a
 * watcher — is an ordinary push with the native Back, which returns to the
 * screen it was opened from.
 *
 * The sidebar is the stack's own `layout` (`SidebarShell`): one navigator,
 * one history, with the drawer or docked column around it. It is also the
 * task list and the list of tabs, so there is no Tasks screen to go to, and
 * the route in front is the only selection either list marks.
 *
 * The back control shows its chevron and no word. iOS 26 draws every header
 * control on a glass capsule, and a capsule wide enough to hold the previous
 * screen's name is heavier than anything under it — while the chevron alone
 * says the same thing and leaves the title its width.
 *
 * The list roots carry the platform's large title: it is the one heading a
 * list screen gets, it collapses into the bar as the list scrolls, and it is
 * what makes the screen read as the system's own rather than a page drawn
 * inside it. A thread's title is the person's words and can be any length, so
 * that screen keeps the bar-height title that truncates gracefully.
 */
const RootStack = createNativeStackNavigator({
  layout: ({ children, navigation, state }) => (
    <SidebarShell navigation={navigation} state={state}>
      {children}
    </SidebarShell>
  ),
  // A sheet or modal is presented away from the screens: its safe area is
  // where it was presented, not the stack's or the sidebar's beside it, and no
  // region the shell measured lies over it.
  screenLayout: ({ children, options }) =>
    options.presentation === undefined || options.presentation === "card" ? (
      children
    ) : (
      <Pane>{children}</Pane>
    ),
  screenOptions: stackScreenOptions,
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
        title: "Deployments",
      }),
    },
    // Chat: the one conversation a Deployment opens into, and the root every
    // other screen of it is pushed over. It renders Home itself — or the first
    // message before Home exists — and never hands over to another route.
    Home: { screen: HomeScreen, options: { title: CHAT_THREAD_TITLE } },
    Specialists: {
      screen: SpecialistsScreen,
      options: { ...destinationOptions(), title: "Specialists" },
    },
    // Every tab this person may see, from the sidebar like Specialists. A tab
    // opened from here is shown alone.
    Tabs: { screen: TabsScreen, options: { ...destinationOptions(), title: "Tabs" } },
    // Everything set to run on its own, from the sidebar like Tabs.
    Schedules: {
      screen: SchedulesScreen,
      options: { ...destinationOptions(), title: "Schedules" },
    },
    // One schedule, from Schedules or a thread's Around sheet. Its name is
    // the large title, set once it loads.
    Schedule: { screen: ScheduleScreen, options: { headerLargeTitle: true, title: "" } },
    // One specialist, over the directory. Its name is the large title, set
    // once it loads, so it folds into the bar as its work scrolls under it.
    Specialist: { screen: SpecialistScreen, options: { headerLargeTitle: true, title: "" } },
    Thread: {
      screen: ThreadScreen,
      // A task just started takes the place of its New task screen: it fades
      // in where that screen was, the composer where it was, rather than
      // sliding over it as if it were a step further in.
      options: ({ route }) => ({
        ...(isRecord(route.params) && route.params["started"] === true
          ? { animation: "fade" as const }
          : {}),
        title: "Thread",
      }),
    },
    // A task before it exists: the first message makes it, then the task's
    // own screen replaces this one.
    NewTask: { screen: NewTaskScreen, options: { title: "New task" } },
    // Every task on the Deployment, narrowed by the search field in its bar,
    // from the sidebar's magnifying glass.
    TaskSearch: { screen: TaskSearchScreen, options: { title: "Search" } },
    // A conversation's tabs and Mac apps, pushed over it: the grid, or one
    // tab or app, which a tile pushes over the grid; or one tab, app or phone
    // alone, from Tabs or the sidebar. The native
    // Back (and swipe, and Android's back) returns, and leaving stops nothing.
    WorkspaceBrowser: { screen: WorkspaceBrowserScreen, options: { title: "Tabs" } },
    // The model picker starts compact and can expand for a long catalog. It
    // draws its own bar as the list's header: Android's form sheet has no
    // native header, and the list must be the sheet's direct child for iOS to
    // size it, so one in-content bar serves both platforms.
    ThreadSettings: {
      screen: ThreadSettingsScreen,
      options: {
        headerShown: false,
        presentation: "formSheet",
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
        presentation: "formSheet",
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Find",
      }),
    },
    NewThread: {
      screen: NewThreadScreen,
      options: {
        headerShown: false,
        presentation: "formSheet",
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Choose AI",
      },
    },
    // A new specialist is a name, an icon and where its files live; like the
    // model picker it draws its own bar, for the same Android reason.
    NewSpecialist: {
      screen: NewSpecialistScreen,
      options: {
        headerShown: false,
        presentation: "formSheet",
        sheetAllowedDetents: [0.95],
        sheetGrabberVisible: true,
        title: "New specialist",
      },
    },
    // One step of an agent's work. Its own content names it, so the sheet has
    // no bar; it opens part-way so the transcript it came from stays in view.
    ThreadStep: {
      screen: ThreadStepScreen,
      options: {
        headerShown: false,
        presentation: "formSheet",
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
        presentation: "formSheet",
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
        presentation: "formSheet",
        sheetAllowedDetents: [0.6, 0.95],
        sheetGrabberVisible: true,
        title: "Around this thread",
      },
    },
    // A long list opens full height like the pages it leads to: a half-height
    // detent would spend the first scroll on growing the sheet, and the next
    // on dragging it back down.
    Settings: {
      screen: SettingsScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        presentation: "modal",
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
        presentation: "modal",
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
        presentation: "modal",
        title: "Browser profiles",
      }),
    },
    // The accounts agents use, a modal over Settings like Chrome: a sign-in it
    // starts finishes in the system browser sheet and returns here.
    ConnectedApps: {
      screen: ConnectedAppsScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        presentation: "modal",
        title: "Connected apps",
      }),
    },
    Computer: {
      screen: ComputerScreen,
      options: ({ navigation }) => ({
        ...headerActions({
          right: { label: "Done", onPress: () => navigation.goBack(), variant: "done" },
        }),
        presentation: "modal",
        title: "Computer",
      }),
    },
    AddIphone: {
      screen: AddIphoneScreen,
      options: ({ navigation }) => ({
        ...headerActions({ left: { label: "Cancel", onPress: () => navigation.goBack() } }),
        presentation: "formSheet",
        sheetAllowedDetents: [0.95],
        sheetGrabberVisible: true,
        title: "Add this iPhone",
      }),
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
        presentation: "modal",
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
        presentation: "modal",
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
        AddPersonal: {
          screen: AddPersonalScreen,
          options: ({ navigation }) => ({
            ...headerActions({ left: { label: "Back", onPress: () => navigation.goBack() } }),
            title: "Computer",
          }),
        },
      },
    },
  },
});

/**
 * A sidebar destination other than Chat. It has the Menu where Back would be,
 * so the edge swipe belongs to the sidebar rather than to a pop, and it fades
 * in rather than sliding: it is a place beside Chat, not a step deeper into it.
 * Android's Back still returns to Chat.
 */
function destinationOptions(): NativeStackNavigationOptions {
  return {
    animation: "fade",
    gestureEnabled: false,
    headerBackVisible: false,
    headerLargeTitle: true,
  };
}

type OpensteerRootParamList = {
  readonly AddDeployment: undefined;
  readonly AddIphone: { readonly deploymentId: string };
  readonly AddPersonal: undefined;
  readonly AddServer: undefined;
  readonly Chrome: ChromeDestination;
  readonly BrowserProfiles: BrowserProfilesDestination;
  readonly BrowserHistory: BrowserHistoryDestination;
  readonly ConnectedApps: ConnectedAppsDestination;
  readonly Computer: { readonly deploymentId: string; readonly machineId: string };
  readonly ConversationActivity: {
    readonly deploymentId: string;
    readonly threadId: string;
    /** The reply's turn, by its key. Absent, the reply under way or else the latest. */
    readonly turnKey?: string | undefined;
  };
  readonly Deployments: undefined;
  readonly DeploymentSwitcher: undefined;
  readonly Home: {
    readonly deploymentId: string;
    /** An exact update in Chat to open at, from a link, a notification or Find. */
    readonly messageId?: string | undefined;
    /** A page Ask handed over, included with Chat's next message unless removed. */
    readonly page?: BrowserPageContentPart | undefined;
    /**
     * An update from a task to answer in Chat. It is already in Chat's saved
     * draft; this hands it to the composer that is on screen, then clears.
     */
    readonly quote?: ThreadDraftQuote | undefined;
    readonly requestId?: string | undefined;
  };
  readonly NewSpecialist: { readonly deploymentId: string };
  readonly NewTask: {
    readonly deploymentId: string;
    /** A page Ask handed over, included with the first message unless removed. */
    readonly page?: BrowserPageContentPart | undefined;
    readonly workspaceId: string;
  };
  readonly NewThread: {
    readonly deploymentId: string;
    /** Set when the choice is for Chat's first message rather than a new task's. */
    readonly home?: boolean;
    /** The first-message Send that opened this picker, if any. */
    readonly pickerAttemptId?: string;
  };
  readonly Schedule: ScheduleDestination;
  readonly Schedules: { readonly deploymentId: string };
  readonly Settings: undefined;
  readonly Specialist: { readonly deploymentId: string; readonly workspaceId: string };
  readonly Specialists: { readonly deploymentId: string };
  readonly Tabs: { readonly deploymentId: string };
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
    /** Set when New task just made this task and this screen replaces it. */
    readonly started?: boolean;
    readonly threadId: string;
  };
  readonly ThreadAround: { readonly deploymentId: string; readonly threadId: string };
  readonly ThreadFind: { readonly deploymentId: string; readonly threadId: string };
  readonly ThreadSettings: { readonly deploymentId: string; readonly threadId: string };
  readonly ThreadStep: {
    readonly deploymentId: string;
    readonly entryId: string;
    readonly threadId: string;
  };
  readonly WorkspaceBrowser: SurfacesRoute;
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
