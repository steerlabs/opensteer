import { BrowserPageMenu, type BrowserPageMenuAction } from "./browser-page-menu.js";
import { editingClipboardMaxBytes } from "@opensteer/protocol/editing";
import { useActionReview } from "@opensteer/client/react";
import { ActionReviewSheet } from "../ui/action-review.js";
import {
  passkeyNotice,
  browserActingTabId,
  browserSiteForTab,
  browserTabTitle,
  parseNavigationInput,
  reviewHostAction,
  webSearchUrl,
  type BrowserTabOpenHandle,
  type BrowserCommand,
  type BrowserSessionSummary,
  type HostClient,
  type PlaceAgent,
} from "@opensteer/client/host";
import { BrowserSurfaceIdSchema, type BrowserPageContentPart } from "@opensteer/core";
import { browserPromptTextMaxLength, browserViewportFits } from "@opensteer/protocol";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import {
  Alert,
  I18nManager,
  Linking,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  GestureDetector,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
} from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type LayoutAnimation,
  type SharedValue,
} from "react-native-reanimated";
import type { EditingOperation } from "@opensteer/client/editing";
import type { BrowserAutofillState } from "@opensteer/client/host";
import type { EditingCaret, EditingContext } from "@opensteer/protocol/editing";
import { createMobileBrowserEditing } from "./browser-editing.js";
import {
  NativeEditingProxy,
  type NativeEditingProxyHandle,
} from "../../modules/remote-text-input/src/editing-proxy.js";
import { LegacyInput } from "../../modules/remote-text-input/src/legacy-input.js";
import type { EditingTargetAbilities } from "@opensteer/client/editing";
import { operationDetail } from "../client/mobile-client.js";
import { color, material, radius, space, touchTarget, type as textType } from "../theme.js";
import type { NativeMenuOption, NativeMenuSection } from "../thread/composer-menu.js";
import { GlassSurface } from "../ui/glass.js";
import { appear, duration, exit, move } from "../ui/motion.js";
import { AppText, Notice } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import {
  AddressCapsule,
  AddressEditor,
  type OpenTabSuggestion,
  type PageDevice,
} from "./address-bar.js";
import { BrowserStream, submitBrowserCommand, useBrowserFeedState } from "./browser-stream.js";
import { ChromeSignInAction } from "./chrome-sign-in-action.js";
import { LoginChips } from "./login-chips.js";
import { createPageAutofill } from "./page-autofill.js";
import { FollowBand } from "./pair-chrome.js";
import { pageSite, viewedPage } from "./surface-route.js";
import { ToolbarAsk, ToolbarLeave, useNativeBarAway } from "./place-bar.js";
import { FloatingPlaceStatus, PlaceVoiceDock, usePlaceStatus } from "./place-foot.js";
import { barFloats } from "./floating-bar.js";
import { PageChromeProvider, PageEdge, useFloatingBar, type PageChrome } from "./floating-page.js";
import { useContentInsets } from "../ui/pane.js";
import { Toolbar, ToolbarButton, ToolbarCapsule, ToolbarMenu } from "./toolbar.js";
import { systemBrowserLabel } from "./system-browser.js";

/** The shape a page takes before its first picture says otherwise. */
const defaultPageAspect = 16 / 9;
/** A command the page refused: its feed went away after the view last drew. */
const refusedNotice = "The page is reconnecting. Try again in a moment.";
/** How long a fill that did not happen is said, over a page the person is still using. */
const fillNoticeMs = 5000;
/** Where a page's bar moves from under it to over it, as Safari's does on iPad. */
const regularWidth = 600;
/** What the page's bar adds while a Thread is beside it. */
export interface PagePairChrome {
  /** Ask, and whose Thread is beside the page, as More's own sections. */
  readonly menu: readonly NativeMenuSection[];
}

/** Keeping up with the Thread's agent as it moves between tabs. */
export interface PageFollow {
  /** The agent's mark; null for a Thread the reader cannot name. */
  readonly agent: PlaceAgent | null;
  /** The agent's tab, while the person is not following it there. */
  readonly away: { readonly title: string } | null;
  readonly following: boolean;
  readonly onResume: () => void;
}
/** Room left beside or under a page that is worth offering Fit for, as a share of its place. */
const fitBand = 0.15;
/** A gutter this wide holds Fit's words; a narrower one holds only its glyph. */
const fitWordsWidth = 160;
/** How far a page can be pinched in: enough to read a desktop page's small print. */
const maxZoom = 4;

/**
 * One browser page, used as Safari is used on a phone: the page as large as
 * its place allows, with one bar and nothing else around it: the way out, the
 * page's address, the tabs, Ask and ⋯, which holds its history. It sits under
 * the page; where the page has a regular width it sits over it instead, with
 * Back and Forward beside the address, as Safari on iPad has it. Opened from a
 * conversation, the page's foot says what that conversation is doing.
 *
 * The page is drawn at its own shape, as wide as its place and pinned to the
 * top; a page taller than the room fits by its height. It is never resized by
 * being looked at — only Fit resizes it, to exactly its place — and a page that
 * leaves real room beside or under it offers Fit there.
 *
 * Tapping a field the page reports opens the keyboard at once, and the page
 * slides up so the caret stays in view over it rather than shrinking. The
 * person and the agent use the page at the same time; nothing here takes it
 * from either.
 */
export function BrowserPage(props: {
  readonly nativeContent?: ReactNode;
  /** In front of the reader, with the app in the foreground. */
  readonly active: boolean;
  readonly connected: boolean;
  readonly hostClient: HostClient;
  /** The page being read, whenever it changes, for the composer to include. */
  readonly onViewing: (page: BrowserPageContentPart | null) => void;
  /** The person is typing into the page, and the page's pane should make room. */
  readonly onTyping: (typing: boolean) => void;
  readonly session: BrowserSessionSummary;
  readonly tabId: string;
  readonly editAddress: boolean;
  readonly onOpenTab: (opening: BrowserTabOpenHandle) => void;
  /** Another tab of this browser, chosen from its address or its suggestions. */
  readonly onSwitchTab: (tabId: string) => void;
  /** This browser's tabs, as a sheet. */
  readonly onShowTabs: () => void;
  readonly onClosed: () => void;
  /** The browser's Workspace, whose agents may use a site once it is signed in. */
  readonly workspaceName: string;
  /** Which way the page came from another tab, by tab order; 0 when it opened here. */
  readonly arrival?: -1 | 0 | 1;
  /** The device the page runs on, where that is not this one. */
  readonly device?: PageDevice | null;
  readonly follow?: PageFollow | null;
  readonly pair?: PagePairChrome | null;
  /** The person moved this page themselves: back, forward, an address, a new tab. */
  readonly onSteer?: () => void;
}): ReactNode {
  const { hostClient, onSwitchTab, onTyping, onViewing, session, tabId } = props;
  const surfaceId = BrowserSurfaceIdSchema.parse(tabId);
  useNativeBarAway();
  const dialog = session.dialog?.surfaceId === tabId ? session.dialog : null;
  const [prompt, setPrompt] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const promptText = prompt?.id === dialog?.id ? (prompt?.text ?? "") : "";
  const catalogTab = session.tabCatalog?.tabs.find((candidate) => candidate.id === tabId);
  const liveTab = session.tabs.find((candidate) => candidate.id === tabId);
  const tab =
    liveTab ??
    (catalogTab
      ? { id: surfaceId, title: catalogTab.title, url: catalogTab.site, active: false }
      : undefined);
  const navigationFailed = tab?.navigationFailed || catalogTab?.navigationFailed;
  const [problem, setProblem] = useState<string | null>(null);
  const [addressOpen, setAddressOpen] = useState(props.editAddress);
  // Null shows the page's own address; anything else is the person's, kept
  // until they go there or put it away.
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const proxy = useRef<NativeEditingProxyHandle>(null);
  const menuInteraction = useRef(0);
  useEffect(
    () => () => {
      menuInteraction.current++;
    },
    [],
  );
  const [mayType, setMayType] = useState(false);
  const [typing, setTyping] = useState(false);
  const [pageFocused, setPageFocused] = useState(true);
  const [dragSelect, setDragSelect] = useState(false);
  const [inputEpoch, setInputEpoch] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const openingTab = useRef(false);
  useEffect(() => () => onTyping(false), [onTyping]);
  const [aspect, setAspect] = useState(defaultPageAspect);
  const [drawnGeometry, setDrawnGeometry] = useState<number | null>(null);
  const onPageSize = useCallback((size: { readonly height: number; readonly width: number }) => {
    if (size.width > 0 && size.height > 0) setAspect(size.width / size.height);
  }, []);
  const feed = useBrowserFeedState(hostClient, session.id, tabId);
  const subscribePasskeys = useCallback(
    (listener: () => void) =>
      hostClient.browserPasskeys?.subscribe(session.id, tabId, listener) ?? (() => {}),
    [hostClient, session.id, tabId],
  );
  const readPasskeys = useCallback(
    () => hostClient.browserPasskeys?.get(session.id, tabId) ?? null,
    [hostClient, session.id, tabId],
  );
  const passkey = useSyncExternalStore(subscribePasskeys, readPasskeys, readPasskeys);

  const latestSend = useRef<(command: BrowserCommand) => boolean>(() => false);
  const clipboard = useMemo(() => {
    let port: Promise<
      import("../../modules/remote-text-input/src/clipboard.js").MobileClipboardPort
    > | null = null;
    return {
      write: async (
        items: readonly import("@opensteer/client/editing").EditingClipboardPayloadItem[],
      ) => {
        port ??= import("../../modules/remote-text-input/src/clipboard.js").then((module) =>
          module.createMobileClipboardPort(),
        );
        return (await port).write(items);
      },
    };
  }, []);
  const editing = useMemo(
    () =>
      createMobileBrowserEditing(
        hostClient,
        session.id,
        tabId,
        (command) => latestSend.current(command),
        clipboard,
      ),
    [hostClient, session.id, tabId, clipboard],
  );
  const editingState = useSyncExternalStore(editing.subscribe, editing.get);
  const editable = !editingState.negotiated || editingState.context?.field != null;
  useEffect(() => {
    if (!editable) {
      setTyping(false);
      setMayType(false);
    }
  }, [editable]);
  useEffect(() => {
    if (!props.active || !props.connected || props.nativeContent) {
      setTyping(false);
      return;
    }
    return editing.activate((message) => {
      setProblem(message);
      if (!editing.get().negotiated) setTyping(false);
    });
  }, [editing, props.active, props.connected, props.nativeContent]);
  const [confirmingLogin, setConfirmingLogin] = useState<string | null>(null);
  const [fillNotice, setFillNotice] = useState<string | null>(null);
  useEffect(() => {
    if (fillNotice === null) return;
    const timer = setTimeout(() => setFillNotice(null), fillNoticeMs);
    return () => clearTimeout(timer);
  }, [fillNotice]);
  const autofill = useMemo(
    () =>
      createPageAutofill({
        editing,
        authenticate: async () =>
          (await import("../thread/password-approval-auth.js")).authenticatePasswordApproval(
            "fill",
          ),
        onConfirming: setConfirmingLogin,
        // The device check can take the app out of the foreground and the
        // keyboard with it; the person is still typing into the field.
        onChosen: () => {
          setFillNotice(null);
          setPageFocused(true);
          setTyping(true);
        },
        onFilled: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
        onUnfilled: (detail) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setFillNotice(detail);
        },
      }),
    [editing],
  );
  useEffect(() => autofill.stop, [autofill]);
  const chooseLogin = useCallback(
    (loginId: string) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      void autofill.choose(loginId);
    },
    [autofill],
  );
  const channelReady =
    props.active && props.connected && session.state === "ready" && feed.status === "live";
  const { review: closeReview, ask: askClose, dismiss: dismissClose } = useActionReview(hostClient);
  const ready = channelReady && closeReview === null;
  // A tap the page answers by focusing a field brings the keyboard up, as a
  // tap on a field does in Safari. Only a page that reports its fields can say
  // so; on an older one the tap offers the keyboard instead.
  const fieldFocused = editingState.negotiated && editingState.context?.field != null;
  useEffect(() => {
    if (mayType && fieldFocused && ready) {
      setMayType(false);
      setTyping(true);
    }
  }, [fieldFocused, mayType, ready]);

  const viewed = tab === undefined ? null : viewedPage(session, { ...tab, navigationFailed });
  const viewedKey =
    viewed === null ? null : `${viewed.tabId}\u0000${viewed.url}\u0000${viewed.title}`;
  const latestViewed = useRef(viewed);
  latestViewed.current = viewed;
  useEffect(() => {
    onViewing(latestViewed.current);
  }, [onViewing, viewedKey]);
  useEffect(() => () => onViewing(null), [onViewing]);
  // A page's prompt takes the keyboard too, so its answer and buttons stay above it.
  const prompting = dialog?.type === "prompt";
  useEffect(
    () => onTyping(typing || addressOpen || prompting),
    [addressOpen, onTyping, prompting, typing],
  );

  // The page's place: its width, whether it is regular, and the room it rests
  // in. The resting room is kept while the keyboard is up, so the page keeps
  // its size and slides instead of shrinking under it.
  const [width, setWidth] = useState(0);
  const regular = width >= regularWidth;
  const [room, setRoom] = useState({ height: 0, width: 0 });
  const [visibleHeight, setVisibleHeight] = useState(0);
  const lifted = typing || addressOpen || prompting;
  const onStage = (event: LayoutChangeEvent) => {
    const { height, width: stageWidth } = event.nativeEvent.layout;
    setVisibleHeight(height);
    // The keyboard only takes height: while it is up, the resting height is
    // kept and anything else — a rotation, a pane resizing beside it — is
    // measured anew. A page opened straight into its address has no resting
    // room yet, so its first measure stands for it until the keyboard goes.
    setRoom((current) =>
      (current.height === height && current.width === stageWidth) ||
      (lifted && current.height > 0 && current.width === stageWidth)
        ? current
        : { height, width: stageWidth },
    );
  };
  const status = usePlaceStatus(lifted);
  // Where the page rests: its place, less the status row's room at its foot.
  const rested = useMemo(
    () => ({ height: Math.max(0, room.height - status.height), width: room.width }),
    [room.height, room.width, status.height],
  );
  const picture = pictureBox(rested, aspect);

  // A refusal belongs to the feed admission it met; the next admission has recovered.
  const [refusedAdmission, setRefusedAdmission] = useState<string | null>(null);
  const refused = refusedAdmission !== null && refusedAdmission === feed.admissionId;
  const send = (command: BrowserCommand): boolean => {
    if (!ready) return false;
    if (command.type.startsWith("navigation.")) {
      setInputEpoch((value) => value + 1);
      editing.dismissMenu();
    }
    if (
      command.type === "navigation.back" ||
      command.type === "navigation.forward" ||
      command.type === "navigation.go"
    )
      props.onSteer?.();
    const targeted = { ...command, surfaceId };
    const taken = submitBrowserCommand(hostClient, session.id, targeted);
    if (!taken) setRefusedAdmission(feed.admissionId ?? null);
    return taken;
  };
  latestSend.current = send;
  const viewport = () => {
    const size = { height: Math.round(rested.height), width: Math.round(rested.width) };
    return size.width > 0 && size.height > 0 && browserViewportFits(size.width, size.height)
      ? size
      : null;
  };
  const navigate = () => {
    if (!ready) return;
    const address = (addressDraft ?? tab?.url ?? "").trim();
    const parsed = address === "about:blank" ? null : parseNavigationInput(address);
    const url =
      address === "about:blank"
        ? address
        : parsed?.kind === "url"
          ? parsed.url
          : parsed?.kind === "search"
            ? webSearchUrl(parsed.query)
            : null;
    if (url === null) {
      setProblem("Enter a valid website address.");
      return;
    }
    // The address stays as typed until the page has taken it.
    if (!send({ type: "navigation.go", url, typed: true })) return;
    hostClient.browserPreferences.lastBrowsingChoice = session.profileId
      ? { kind: "profile", profileId: session.profileId }
      : { kind: "guest" };
    setProblem(null);
    setAddressDraft(null);
    setAddressOpen(false);
  };
  const closeTab = () => {
    const action = { kind: "close-tab", sessionId: session.id, tabId } as const;
    if (session.attachedRunIds.length > 0) askClose(action);
    else
      void reviewHostAction(hostClient, action)
        ?.confirm()
        .then((closed) => {
          if (closed) props.onClosed();
        })
        .catch((error: unknown) =>
          setProblem(operationDetail(error, "This tab could not be closed.")),
        );
  };
  const openTab = () => {
    if (openingTab.current) return;
    openingTab.current = true;
    props.onSteer?.();
    try {
      const size = viewport();
      props.onOpenTab(
        hostClient.beginBrowserTabOpen(
          { sessionId: session.id },
          size ? { viewport: size } : undefined,
        ),
      );
    } catch (error) {
      openingTab.current = false;
      setProblem(operationDetail(error, "A new tab could not be opened."));
    }
  };
  // Fit takes away a size an agent chose for its own work, so it asks first.
  const fit = () => {
    const size = viewport();
    if (tab === undefined || size === null) return;
    const apply = () => send({ type: "viewport.set", surfaceId: tab.id, ...size });
    if (liveTab?.sizedByAgent === true)
      Alert.alert(
        "Fit this page to your screen?",
        "An agent set this page’s size for its work. It will see the page at your size from now on.",
        [
          { style: "cancel", text: "Cancel" },
          { onPress: apply, text: "Fit" },
        ],
      );
    else apply();
  };

  const navigationProblem = navigationFailed
    ? "This page could not be loaded. Reload to try again."
    : null;
  const pageProblem = problem ?? navigationProblem;
  const site = tab ? pageSite(tab.url) : null;
  const title = tab ? browserTabTitle(tab) : "Page";
  const signInSite =
    session.state === "ready" && tab ? browserSiteForTab({ navigationFailed, url: tab.url }) : null;
  const pageUrl = site === null ? null : (tab?.url ?? null);
  const acting = browserActingTabId(session) === tabId;
  const loading = liveTab?.loading === true || catalogTab?.loading === true;
  // A browser that reports where its history goes says so; one that does not
  // leaves both ways open, as it did before it could say.
  const canGoBack = catalogTab?.canGoBack !== false;
  const canGoForward = catalogTab?.canGoForward !== false;

  const tabs = useMemo(() => orderedTabs(session), [session]);
  const position = tabs.findIndex(({ id }) => id === tabId);
  const switchBy = useCallback(
    (direction: -1 | 1) => {
      const next = tabs[position + direction];
      if (position >= 0 && next !== undefined) onSwitchTab(next.id);
    },
    [onSwitchTab, position, tabs],
  );
  const canSwitch =
    position >= 0 && (tabs[position - 1] !== undefined || tabs[position + 1] !== undefined);
  const fitted =
    picture.height > 0 &&
    Math.abs(picture.width - rested.width) <= 2 &&
    Math.abs(picture.height - rested.height) <= 2;
  const navigationKey = `${inputEpoch}:${catalogTab?.documentId ?? ""}:${tab?.url ?? ""}:${loading}`;
  useEffect(() => {
    setDragSelect(false);
    editing.dismissMenu();
  }, [ready, navigationKey, editing]);
  const pageMenu =
    ready &&
    editingState.menu &&
    (editingState.menu.geometryRevision === undefined ||
      editingState.menu.geometryRevision === drawnGeometry)
      ? editingState.menu
      : null;
  const menuScope = useRef({ ready, navigationKey });
  menuScope.current = { ready, navigationKey };
  const pageAction = (action: BrowserPageMenuAction) => {
    if (!pageMenu || !ready) return;
    const interaction = ++menuInteraction.current;
    if (action === "copy" || action === "cut") {
      if (
        !pageMenu.selection ||
        editingState.context?.field?.sensitive ||
        (action === "cut" && !pageMenu.editable)
      )
        return;
      editing.send({ kind: action });
    } else if (action === "select-all") editing.send({ kind: "command", command: "selectAll" });
    else if (action === "paste") {
      if (!pageMenu.editable) return;
      const context = editingState.context?.contextId;
      void Clipboard.getStringAsync()
        .then((text) => {
          if (
            !menuScope.current.ready ||
            menuInteraction.current !== interaction ||
            menuScope.current.navigationKey !== navigationKey ||
            editing.get().context?.contextId !== context
          )
            return;
          const bytes = new TextEncoder().encode(text);
          if (bytes.length > editingClipboardMaxBytes) {
            setProblem("Clipboard too large.");
            return;
          }
          if (bytes.length) editing.send({ kind: "paste", items: [{ type: "text/plain", bytes }] });
        })
        .catch(() => setProblem("Clipboard unavailable."));
    } else if (action === "copy-link" && pageMenu.linkUrl) {
      void clipboard
        .write([{ type: "text/plain", bytes: new TextEncoder().encode(pageMenu.linkUrl) }])
        .then((outcome) => {
          if (outcome !== "written" && outcome !== "empty") setProblem(`Clipboard ${outcome}.`);
        })
        .catch(() => setProblem("Clipboard unavailable."));
    } else if (action === "open-link" && pageMenu.linkUrl) {
      try {
        props.onOpenTab(
          hostClient.beginBrowserTabOpen({ sessionId: session.id }, { url: pageMenu.linkUrl }),
        );
      } catch (error) {
        setProblem(operationDetail(error, "A new tab could not be opened."));
      }
    }
    editing.dismissMenu();
  };

  const pair = props.pair ?? null;
  const follow = props.follow ?? null;
  // The bar is over the page where it is wide, and always while a Thread is beside it.
  const top = regular || pair !== null;
  const { height: windowHeight } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const arrival = props.arrival ?? 0;
  // A page on this phone runs under its own controls, as Safari's does: they float over it and
  // the bar shrinks as it is read. A streamed page cannot leave room for them, so its bar stands.
  const local = props.nativeContent !== undefined && props.nativeContent !== null;
  const edge = top ? "top" : "bottom";
  const floats = local && barFloats({ edge, height: windowHeight, paired: pair !== null });
  const floating = useFloatingBar(edge, !floats || addressOpen || dialog !== null || signingIn);
  const insets = useContentInsets();
  // Under the home indicator too, where the bar floats over the page's foot.
  const bleed = floats && edge === "bottom" ? insets.bottom : 0;
  const [footHeight, setFootHeight] = useState(0);
  const [headHeight, setHeadHeight] = useState(0);
  // The editor stands where the bar was without moving the page's own edges.
  const onFootHeight = useCallback(
    (height: number) => {
      if (!addressOpen) setFootHeight(height);
    },
    [addressOpen],
  );
  const onHeadHeight = useCallback(
    (height: number) => {
      if (!addressOpen) setHeadHeight(height);
    },
    [addressOpen],
  );
  const chrome = useMemo(
    (): PageChrome | null =>
      local
        ? {
            barInsets: { bottom: footHeight, top: floats && edge === "top" ? headHeight : 0 },
            onPageScroll: floats ? floating.onPageScroll : null,
          }
        : null,
    [edge, floating.onPageScroll, floats, footHeight, headHeight, local],
  );
  // A phone's bar has room for what it is used for most; Drag/select waits in More.
  const dragButtonFits = regular && pair === null;
  const menu: NativeMenuSection[] = [
    [
      {
        disabled: !ready,
        icon: "arrow.clockwise",
        id: "reload",
        label: "Reload",
        onPress: () => void send({ type: "navigation.reload" }),
      },
      ...(regular
        ? []
        : [
            {
              disabled: !ready || !canGoBack,
              icon: "chevron.backward",
              id: "back",
              label: "Back",
              onPress: () => void send({ type: "navigation.back" }),
            } satisfies NativeMenuOption,
            {
              disabled: !ready || !canGoForward,
              icon: "chevron.forward",
              id: "forward",
              label: "Forward",
              onPress: () => void send({ type: "navigation.forward" }),
            } satisfies NativeMenuOption,
          ]),
      {
        disabled: !channelReady,
        icon: "plus.square.on.square",
        id: "new-tab",
        label: "New tab",
        onPress: openTab,
      },
      ...(fitted
        ? []
        : [
            {
              disabled: !ready || tab === undefined,
              icon: "arrow.up.left.and.arrow.down.right",
              id: "fit",
              label: "Fit to screen",
              onPress: fit,
            } satisfies NativeMenuOption,
          ]),
      ...(dragButtonFits
        ? []
        : [
            {
              disabled: !ready,
              id: "drag-select",
              label: dragSelect ? "Done selecting" : "Drag/select",
              onPress: () => setDragSelect((value) => !value),
            } satisfies NativeMenuOption,
          ]),
    ],
    pageUrl === null
      ? []
      : [
          {
            icon: "link",
            id: "copy",
            label: "Copy link",
            onPress: () => void Clipboard.setStringAsync(pageUrl),
          },
          {
            icon: "square.and.arrow.up",
            id: "share",
            label: "Share…",
            onPress: () => void Share.share({ message: pageUrl, url: pageUrl }).catch(noop),
          },
          {
            icon: "safari",
            id: "open",
            label: systemBrowserLabel,
            onPress: () => void Linking.openURL(pageUrl).catch(noop),
          },
        ],
    signInSite === null
      ? []
      : [
          {
            icon: "person.badge.key",
            id: "chrome",
            label: "Sign in with Chrome",
            onPress: () => setSigningIn(true),
          },
        ],
    ...(pair?.menu ?? []),
    [
      {
        destructive: true,
        disabled: !props.connected || session.state !== "ready" || !tab,
        icon: "xmark.circle",
        id: "close",
        label: "Close tab",
        onPress: closeTab,
      },
    ],
  ];

  const address = (
    <AddressCapsule
      acting={acting}
      arriving={arrival !== 0}
      back={
        regular
          ? { enabled: ready && canGoBack, onPress: () => void send({ type: "navigation.back" }) }
          : null
      }
      device={props.device ?? null}
      favicon={liveTab?.favicon ?? null}
      following={follow?.following === true ? { agent: follow.agent } : null}
      forward={
        regular
          ? {
              enabled: ready && canGoForward,
              onPress: () => void send({ type: "navigation.forward" }),
            }
          : null
      }
      loading={loading}
      onEdit={() => setAddressOpen(true)}
      onSwitch={canSwitch ? switchBy : null}
      secure={tab?.url.startsWith("https://") === true}
      site={site}
    />
  );
  const tabsButton = (
    <ToolbarButton
      accessibilityHint="Shows this browser’s tabs"
      count={tabs.length}
      label={`Tabs, ${tabs.length}`}
      onPress={props.onShowTabs}
    />
  );
  const more = <ToolbarMenu label="More" sections={menu} symbol="ellipsis" title={title} />;
  const bar = (
    <Toolbar edge={top ? "top" : "bottom"} testID="page-toolbar">
      <ToolbarLeave />
      {address}
      {tabsButton}
      {pair === null ? <ToolbarAsk /> : null}
      {dragButtonFits ? (
        <ToolbarButton
          disabled={!ready}
          label={dragSelect ? "Done selecting" : "Drag/select"}
          selected={dragSelect}
          symbol="cursorarrow"
          onPress={() => setDragSelect((value) => !value)}
        />
      ) : null}
      {more}
    </Toolbar>
  );
  const band =
    follow?.away == null || addressOpen ? null : (
      <FollowBand agent={follow.agent} onFollow={follow.onResume} title={follow.away.title} />
    );
  const editor = (
    <AddressEditor
      draft={addressDraft ?? (tab?.url === "about:blank" ? "" : tab?.url) ?? ""}
      editable={closeReview === null}
      onCancel={() => {
        setAddressDraft(null);
        setAddressOpen(false);
      }}
      onChange={setAddressDraft}
      onGo={navigate}
      onSwitch={(next) => {
        setAddressDraft(null);
        setAddressOpen(false);
        onSwitchTab(next);
      }}
      tabs={tabs.filter(({ id }) => id !== tabId)}
      under={top}
    />
  );
  const keyboardOpen = typing && ready && editable && tab !== undefined;

  const slide = useSharedValue(0);
  const caret = editingState.context?.caret ?? null;
  const slideTo = keyboardOpen ? slideFor(caret, picture.height, visibleHeight) : 0;
  useEffect(() => {
    slide.value = withTiming(slideTo, { duration: duration.enter });
  }, [slide, slideTo]);
  const zoom = usePageZoom(picture, keyboardOpen || addressOpen);
  const offer =
    ready && tab !== undefined && !lifted && !zoom.zoomed ? fitOffer(rested, picture) : null;
  // The page's box follows the status row's room on the UI thread, so the
  // page eases into the room it leaves rather than jumping when it comes or goes.
  const { reserve } = status;
  const roomHeight = room.height;
  const roomWidth = room.width;
  const box = useAnimatedStyle(() => {
    const next = pictureBox({ height: roomHeight - reserve.value, width: roomWidth }, aspect);
    return { height: next.height, left: next.left, width: next.width };
  });
  const placed = useAnimatedStyle(() => ({
    transform: [
      { translateX: zoom.x.value },
      { translateY: zoom.y.value + slide.value },
      { scale: zoom.scale.value },
    ],
  }));

  const label = site === null ? title : `${title}, ${site}`;
  const pageDialog =
    dialog === null ? null : (
      <PageDialog
        channelReady={channelReady}
        dialog={dialog}
        onAnswer={(accept) =>
          send({
            type: "dialog.respond",
            accept,
            dialogId: dialog.id,
            ...(accept && dialog.type === "prompt" ? { promptText } : {}),
          })
        }
        onPrompt={(text) => setPrompt({ id: dialog.id, text })}
        promptText={promptText}
        site={site}
      />
    );
  if (local)
    return (
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={styles.page}
        testID="browser-page"
      >
        <ActionReviewSheet
          review={closeReview}
          title="Close this tab?"
          detail="An agent is working here. This tab closes for you and for the agent."
          confirmLabel="Close tab"
          cancelLabel="Cancel"
          onClose={dismissClose}
          onConfirmed={props.onClosed}
          onError={(error) => setProblem(operationDetail(error, "This tab could not be closed."))}
        />
        {top && !floats ? (addressOpen ? editor : bar) : null}
        {top && !floats ? band : null}
        <View style={[styles.native, { marginBottom: -bleed }]} testID="local-page">
          <PageChromeProvider value={chrome}>{props.nativeContent}</PageChromeProvider>
          {addressOpen ? (
            <Pressable
              accessibilityLabel="Keep this page"
              accessibilityRole="button"
              onPress={() => {
                setAddressDraft(null);
                setAddressOpen(false);
              }}
              style={styles.dim}
            />
          ) : null}
          {pageDialog}
          {floats && top ? (
            <PageEdge
              bar={addressOpen ? editor : bar}
              edge="top"
              floating={addressOpen ? null : floating}
              label={label}
              onHeight={onHeadHeight}
              outset={0}
            />
          ) : null}
          <PageEdge
            bar={top ? null : addressOpen ? editor : bar}
            edge="bottom"
            floating={floats && !top && !addressOpen ? floating : null}
            label={label}
            lead={
              <>
                <FloatingPlaceStatus />
                {top ? null : band}
                <PlaceVoiceDock />
              </>
            }
            onHeight={onFootHeight}
            outset={bleed}
          />
        </View>
      </View>
    );
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.page}
      testID="browser-page"
    >
      {pageMenu ? (
        <BrowserPageMenu
          basicInput={editingState.input === "basic"}
          menu={pageMenu}
          sensitive={editingState.context?.field?.sensitive === true}
          onAction={pageAction}
          onDismiss={editing.dismissMenu}
        />
      ) : null}
      <ActionReviewSheet
        review={closeReview}
        title="Close this tab?"
        detail="An agent is working here. This tab closes for you and for the agent."
        confirmLabel="Close tab"
        cancelLabel="Cancel"
        onClose={dismissClose}
        onConfirmed={props.onClosed}
        onError={(error) => setProblem(operationDetail(error, "This tab could not be closed."))}
      />
      {top ? (addressOpen ? editor : bar) : null}
      {top ? band : null}
      {dragSelect ? (
        <AppText role="caption" tone="muted">
          Drag/select · Drag once to select or move content
        </AppText>
      ) : null}
      {props.nativeContent ?? (
        <GestureDetector gesture={zoom.gesture}>
          <View onLayout={onStage} style={styles.stage}>
            <Animated.View
              {...(arrival === 0 || reduceMotion ? {} : { entering: arriveFrom(arrival) })}
              pointerEvents="box-none"
              style={styles.arrival}
            >
              <Animated.View style={[styles.picture, box, placed]}>
                <BrowserStream
                  // The device check takes the app inactive; keeping the stream keeps
                  // its connection, and with it the offer the person chose from.
                  active={props.active || confirmingLogin !== null}
                  tabId={tabId}
                  documentId={liveTab?.documentId}
                  hostClient={hostClient}
                  interactive
                  inputEnabled={closeReview === null && !addressOpen && pageMenu === null}
                  inputEpoch={`${navigationKey}:${keyboardOpen}:${slideTo}`}
                  dragSelect={dragSelect}
                  onDragEnd={() => setDragSelect(false)}
                  label={label}
                  onPageSize={onPageSize}
                  onPresentedGeometry={setDrawnGeometry}
                  onPointerDown={() => {
                    setPageFocused(true);
                    menuInteraction.current++;
                    editing.dismissMenu();
                    proxy.current?.interrupt();
                  }}
                  zoom={zoom.scale}
                  onScroll={() => setMayType(false)}
                  onTap={() => {
                    setAddressOpen(false);
                    setAddressDraft(null);
                    setPageFocused(true);
                    // A page that reports its fields keeps the keyboard up from one
                    // field to the next and puts it away when nothing has focus.
                    if (!editing.get().negotiated) setTyping(false);
                    setMayType(true);
                  }}
                  session={session}
                />
              </Animated.View>
            </Animated.View>
            {offer !== null ? (
              <Animated.View
                entering={appear}
                exiting={exit}
                pointerEvents="box-none"
                style={[
                  styles.fitBand,
                  offer.place === "below"
                    ? {
                        bottom: status.height,
                        height: rested.height - picture.height,
                        left: 0,
                        right: 0,
                      }
                    : { bottom: status.height, right: 0, top: 0, width: picture.left },
                ]}
              >
                <Pressable
                  accessibilityHint="Resizes the page to fill your screen"
                  accessibilityLabel="Fit to screen"
                  accessibilityRole="button"
                  onPress={fit}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <GlassSurface
                    interactive
                    shape="capsule"
                    style={offer.words ? styles.fitChip : styles.fitGlyph}
                  >
                    <Symbol
                      name="arrow.up.left.and.arrow.down.right"
                      size={14}
                      tint={color.ember}
                      weight="semibold"
                    />
                    {offer.words ? <AppText role="secondaryMedium">Fit to screen</AppText> : null}
                  </GlassSurface>
                </Pressable>
              </Animated.View>
            ) : null}
            {addressOpen ? (
              <Pressable
                accessibilityLabel="Keep this page"
                accessibilityRole="button"
                onPress={() => {
                  setAddressDraft(null);
                  setAddressOpen(false);
                }}
                style={styles.dim}
              />
            ) : null}
            {pageProblem === null &&
            !refused &&
            !feed.inputError &&
            !passkey &&
            !fillNotice ? null : (
              <View pointerEvents="box-none" style={styles.top}>
                {passkey ? (
                  <View style={styles.card}>
                    <AppText role="secondary">{passkeyNotice}</AppText>
                  </View>
                ) : null}
                {pageProblem !== null || refused ? (
                  <Notice
                    detail={pageProblem ?? refusedNotice}
                    title="Page unavailable"
                    tone="neutral"
                  />
                ) : feed.inputError ? (
                  // The page refused a touch or key, and says why; the next one clears it.
                  <Notice
                    detail={feed.inputError}
                    title="That didn’t reach the page"
                    tone="neutral"
                  />
                ) : fillNotice !== null ? (
                  <Animated.View entering={appear} exiting={exit}>
                    <Notice detail={fillNotice} title="Your login wasn’t filled" tone="neutral" />
                  </Animated.View>
                ) : null}
              </View>
            )}
            {pageDialog}
            {signingIn && signInSite !== null && tab !== undefined ? (
              <View style={[styles.card, styles.bottom, { bottom: space[12] + status.height }]}>
                <View style={styles.row}>
                  <View style={styles.grow}>
                    <ChromeSignInAction
                      connected={props.connected}
                      hostClient={hostClient}
                      key={`${session.id}:${signInSite}`}
                      sessionId={session.id}
                      tabId={tabId}
                      site={signInSite}
                      url={tab.url}
                      workspaceName={props.workspaceName}
                    />
                  </View>
                  <Pressable
                    accessibilityLabel="Close"
                    accessibilityRole="button"
                    hitSlop={space[8]}
                    onPress={() => setSigningIn(false)}
                    style={styles.iconButton}
                  >
                    <Symbol name="xmark" size={13} tint={color.muted} weight="semibold" />
                  </Pressable>
                </View>
              </View>
            ) : !keyboardOpen && mayType && ready && editable && !editingState.negotiated ? (
              <Animated.View
                entering={appear}
                exiting={exit}
                style={[styles.keyboard, { bottom: space[12] + status.height }]}
              >
                <Pressable
                  accessibilityHint="Types into the page"
                  accessibilityLabel="Keyboard"
                  accessibilityRole="button"
                  onPress={() => {
                    setPageFocused(true);
                    setTyping(true);
                  }}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <GlassSurface interactive shape="capsule" style={styles.keyboardFace}>
                    <Symbol name="keyboard" size={19} tint={color.text} />
                  </GlassSurface>
                </Pressable>
              </Animated.View>
            ) : null}
            {status.row}
          </View>
        </GestureDetector>
      )}
      {!props.nativeContent &&
      ready &&
      tab !== undefined &&
      !addressOpen &&
      !dialog &&
      !signingIn ? (
        <PageTyping
          ref={proxy}
          focused={pageFocused}
          softKeyboard={keyboardOpen}
          onBlur={() => {
            setPageFocused(false);
            setTyping(false);
            setMayType(false);
          }}
          onDone={() => {
            setTyping(false);
            setMayType(false);
          }}
          context={editingState.context}
          abilities={editingState.abilities}
          legacy={!editingState.negotiated}
          sendOperation={(operation) => editing.send(operation)}
          autofill={editingState.autofill}
          confirmingLogin={confirmingLogin}
          onChooseLogin={chooseLogin}
        />
      ) : null}
      {keyboardOpen || top ? null : addressOpen ? (
        editor
      ) : (
        <>
          {band}
          <PlaceVoiceDock />
          {bar}
        </>
      )}
      {top && !keyboardOpen ? <PlaceVoiceDock /> : null}
    </View>
  );
}

/**
 * Pinching the page in, on this phone alone: the page itself never changes,
 * so the agent and every other screen keep seeing it as it is. Two fingers
 * zoom and move the picture; one finger still scrolls and taps the page,
 * through the picture as it is drawn. Let go near its own size and it
 * settles back; it starts again at its own size whenever the page's shape
 * changes or the keyboard comes up.
 */
function usePageZoom(
  picture: { readonly height: number; readonly left: number; readonly width: number },
  held: boolean,
): {
  readonly gesture: ReturnType<typeof useSimultaneousGestures>;
  readonly scale: SharedValue<number>;
  readonly x: SharedValue<number>;
  readonly y: SharedValue<number>;
  /** Pinched past its own size, so it may reach into the room around its place. */
  readonly zoomed: boolean;
} {
  const { height, left, width } = picture;
  const [zoomed, setZoomed] = useState(false);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  // Each gesture keeps its own starting point. A pinch both zooms and follows
  // the fingers, so while one is under way the two-finger pan only keeps
  // its own start current, and carries on from wherever the pinch left off.
  const pinchStart = useSharedValue({ focalX: 0, focalY: 0, scale: 1, x: 0, y: 0 });
  const panStart = useSharedValue({ x: 0, y: 0 });
  const pinching = useSharedValue(false);
  useEffect(() => {
    scale.value = withSpring(1, settle);
    x.value = withSpring(0, settle);
    y.value = withSpring(0, settle);
    setZoomed(false);
  }, [height, held, scale, width, x, y]);
  const pinch = usePinchGesture({
    enabled: !held && width > 0,
    onActivate: (event) => {
      "worklet";
      pinching.value = true;
      scheduleOnRN(setZoomed, true);
      pinchStart.value = {
        focalX: event.focalX - left,
        focalY: event.focalY,
        scale: scale.value,
        x: x.value,
        y: y.value,
      };
    },
    onUpdate: (event) => {
      "worklet";
      const placed = pinched(
        pinchStart.value,
        // The fingers are measured from the page's place; the picture may be inset in it.
        { focalX: event.focalX - left, focalY: event.focalY, scale: event.scale },
        { height, width },
      );
      scale.value = placed.scale;
      x.value = placed.x;
      y.value = placed.y;
    },
    onDeactivate: () => {
      "worklet";
      pinching.value = false;
      if (scale.value < 1.05) {
        scale.value = withSpring(1, settle);
        x.value = withSpring(0, settle);
        y.value = withSpring(0, settle);
        scheduleOnRN(setZoomed, false);
      }
    },
  });
  const pan = usePanGesture({
    enabled: !held && width > 0,
    maxPointers: 2,
    minPointers: 2,
    onActivate: () => {
      "worklet";
      panStart.value = { x: x.value, y: y.value };
    },
    onUpdate: (event) => {
      "worklet";
      if (pinching.value) {
        panStart.value = { x: x.value - event.translationX, y: y.value - event.translationY };
        return;
      }
      x.value = clampTo(panStart.value.x + event.translationX, width, scale.value);
      y.value = clampTo(panStart.value.y + event.translationY, height, scale.value);
    },
  });
  const gesture = useSimultaneousGestures(pinch, pan);
  return { gesture, scale, x, y, zoomed };
}

const settle = { damping: 24, stiffness: 240 } as const;

/**
 * A tab arriving from another: the picture fades in from a few points toward
 * the side it came from by tab order, so the change is seen without the pane
 * itself moving.
 */
function arriveFrom(direction: -1 | 1): () => LayoutAnimation {
  const from = direction * (I18nManager.isRTL ? -8 : 8);
  return () => {
    "worklet";
    const timing = { duration: 180, easing: Easing.out(Easing.quad) };
    return {
      animations: {
        opacity: withTiming(1, timing),
        transform: [{ translateX: withTiming(0, timing) }],
      },
      initialValues: { opacity: 0, transform: [{ translateX: from }] },
    };
  };
}

/**
 * Where a pinch puts the picture: the point of the page that was under the
 * fingers when the pinch began stays under them as they spread and move.
 */
export function pinched(
  start: {
    readonly focalX: number;
    readonly focalY: number;
    readonly scale: number;
    readonly x: number;
    readonly y: number;
  },
  now: { readonly focalX: number; readonly focalY: number; readonly scale: number },
  size: { readonly height: number; readonly width: number },
): { readonly scale: number; readonly x: number; readonly y: number } {
  "worklet";
  const scale = Math.min(maxZoom, Math.max(0.85, start.scale * now.scale));
  const pageX = (start.focalX - start.x) / start.scale;
  const pageY = (start.focalY - start.y) / start.scale;
  return {
    scale,
    x: clampTo(now.focalX - pageX * scale, size.width, scale),
    y: clampTo(now.focalY - pageY * scale, size.height, scale),
  };
}

/** Keeps a zoomed picture covering its own place: no gap opens at either edge. */
function clampTo(offset: number, size: number, scale: number): number {
  "worklet";
  return Math.min(0, Math.max(size - size * Math.max(scale, 1), offset));
}

/**
 * The page at its own shape in its room: as wide as the room and pinned to
 * its top, or, where that would be taller than the room, as tall as the room
 * and centred across it.
 */
export function pictureBox(
  room: { readonly height: number; readonly width: number },
  aspect: number,
): { readonly height: number; readonly left: number; readonly width: number } {
  "worklet";
  if (room.width <= 0 || room.height <= 0 || !(aspect > 0)) return { height: 0, left: 0, width: 0 };
  const byWidth = room.width / aspect;
  if (byWidth <= room.height) return { height: byWidth, left: 0, width: room.width };
  const width = room.height * aspect;
  return { height: room.height, left: (room.width - width) / 2, width };
}

/**
 * Where to offer Fit: in the room a page leaves under it, or, for a page fitted
 * by its height, in the gutter trailing it. Nothing goes over the page, so a
 * gutter with no room for the control offers nothing; Fit stays in More.
 */
export function fitOffer(
  room: { readonly height: number; readonly width: number },
  picture: { readonly height: number; readonly left: number; readonly width: number },
): { readonly place: "below" | "side"; readonly words: boolean } | null {
  if (picture.height <= 0) return null;
  if (room.height - picture.height > room.height * fitBand) return { place: "below", words: true };
  const gutter = picture.left;
  if (gutter * 2 <= room.width * fitBand || gutter < touchTarget + space[8]) return null;
  return { place: "side", words: gutter >= fitWordsWidth };
}

/**
 * How far the page slides up so the caret clears the keyboard: none while it
 * is already in view, otherwise enough to put it a little above the middle of
 * what is left, and never so far that the page's foot leaves its place.
 */
export function slideFor(caret: EditingCaret | null, pageHeight: number, visible: number): number {
  if (caret === null || pageHeight <= 0 || visible <= 0) return 0;
  const margin = space[24];
  const top = caret.y * pageHeight;
  const bottom = (caret.y + caret.height) * pageHeight;
  if (bottom + margin <= visible && top >= margin) return 0;
  const lowest = Math.min(0, visible - pageHeight);
  return Math.max(lowest, Math.min(0, visible * 0.4 - top));
}

/** A browser's tabs in its own order, as its tab strip shows them. */
function orderedTabs(session: BrowserSessionSummary): readonly OpenTabSuggestion[] {
  const catalog = session.tabCatalog?.tabs;
  if (catalog !== undefined)
    return [...catalog]
      .sort((left, right) => left.order - right.order)
      .map((tab) => ({
        favicon: session.tabs.find(({ id }) => id === tab.id)?.favicon ?? null,
        id: tab.id,
        site: pageSite(tab.site),
        title: tab.title || pageSite(tab.site) || "New tab",
      }));
  return session.tabs.map((tab) => ({
    favicon: tab.favicon ?? null,
    id: tab.id,
    site: pageSite(tab.url),
    title: browserTabTitle(tab),
  }));
}

/**
 * A page's own alert, confirm or prompt, drawn as the system draws an alert
 * and naming the site that asks, so it is never taken for Opensteer's own. It
 * is the app's view rather than the system alert because the page can answer
 * or withdraw it from another screen, and only a view of the app's own goes
 * away when it does.
 */
function PageDialog(props: {
  readonly channelReady: boolean;
  readonly dialog: NonNullable<BrowserSessionSummary["dialog"]>;
  readonly onAnswer: (accept: boolean) => void;
  readonly onPrompt: (text: string) => void;
  readonly promptText: string;
  readonly site: string | null;
}): ReactNode {
  const { dialog } = props;
  return (
    <Animated.View entering={appear} exiting={exit} style={styles.dialogScrim}>
      <View accessibilityViewIsModal style={styles.dialog}>
        <View style={styles.dialogFrom}>
          <Symbol name="globe" size={12} tint={color.muted} />
          <AppText numberOfLines={1} role="caption" tone="muted">
            {props.site === null ? "This page says" : `${props.site} says`}
          </AppText>
        </View>
        <AppText role="secondary" style={styles.dialogMessage}>
          {dialog.message}
        </AppText>
        {dialog.type === "prompt" ? (
          <TextInput
            accessibilityLabel="Your answer"
            autoFocus
            editable={props.channelReady}
            key={dialog.id}
            keyboardAppearance="dark"
            maxLength={browserPromptTextMaxLength}
            onChangeText={props.onPrompt}
            selectionColor={color.ember}
            style={styles.input}
            value={props.promptText}
          />
        ) : null}
        <View style={styles.dialogActions}>
          {dialog.type === "alert" ? null : (
            <Pressable
              accessibilityHint="Dismisses this page’s dialog"
              accessibilityLabel="Cancel"
              accessibilityRole="button"
              onPress={() => props.onAnswer(false)}
              style={({ pressed }) => [styles.dialogButton, pressed && styles.pressed]}
            >
              <AppText role="secondaryMedium">Cancel</AppText>
            </Pressable>
          )}
          <Pressable
            accessibilityHint="Accepts this page’s dialog"
            accessibilityLabel="OK"
            accessibilityRole="button"
            onPress={() => props.onAnswer(true)}
            style={({ pressed }) => [
              styles.dialogButton,
              styles.dialogPrimary,
              pressed && styles.pressed,
            ]}
          >
            <AppText role="secondaryMedium" style={styles.dialogPrimaryText}>
              OK
            </AppText>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

function noop(): void {}

/**
 * The page keyboard's own bar, where the page's bar was: the proxy the
 * system keyboard types through, and Done. It uses the same proxy as phone
 * and Mac take-over. While the page offers saved logins for the field, the
 * proxy's capsule draws in to its glyph and the logins take its place; the
 * proxy stays mounted, because it holds the keyboard.
 */
export function PageTyping(props: {
  readonly onDone: () => void;
  readonly focused?: boolean;
  readonly softKeyboard?: boolean;
  readonly onBlur?: () => void;
  readonly context: EditingContext | null;
  readonly sendOperation: (operation: EditingOperation) => boolean;
  readonly abilities?: EditingTargetAbilities;
  readonly legacy?: boolean;
  readonly ref?: Ref<NativeEditingProxyHandle>;
  readonly autofill?: BrowserAutofillState | null;
  readonly confirmingLogin?: string | null;
  readonly onChooseLogin?: (loginId: string) => void;
}): ReactNode {
  const offer = props.autofill?.offer;
  const chooseLogin = props.onChooseLogin;
  const input =
    props.legacy && props.softKeyboard !== false ? (
      <LegacyInput sendOperation={props.sendOperation} onDone={props.onDone} />
    ) : (
      <NativeEditingProxy
        ref={props.ref ?? null}
        context={props.context}
        focused={props.focused ?? true}
        softKeyboard={props.softKeyboard ?? true}
        sendOperation={props.sendOperation}
        onDone={props.onBlur ?? props.onDone}
        {...(props.abilities ? { abilities: props.abilities } : {})}
      />
    );
  return (
    <View
      accessibilityElementsHidden={props.softKeyboard === false}
      importantForAccessibility={props.softKeyboard === false ? "no-hide-descendants" : "auto"}
      pointerEvents={props.softKeyboard === false ? "none" : "auto"}
      style={props.softKeyboard === false ? styles.hardwareInput : undefined}
    >
      <Toolbar edge="bottom" {...(props.softKeyboard === false ? {} : { testID: "page-typing" })}>
        <Animated.View
          layout={move}
          style={offer && chooseLogin ? styles.typingRound : styles.typingField}
        >
          <ToolbarCapsule style={styles.grow}>
            <View style={styles.typingGlyph}>
              <Symbol name="keyboard" size={16} tint={color.muted} />
            </View>
            {input}
          </ToolbarCapsule>
        </Animated.View>
        {offer && chooseLogin ? (
          <LoginChips
            busy={props.confirmingLogin ?? props.autofill?.pending ?? null}
            offer={offer}
            onChoose={chooseLogin}
          />
        ) : null}
        <ToolbarButton label="Done" onPress={props.onDone} selected symbol="checkmark" />
      </Toolbar>
    </View>
  );
}

const styles = StyleSheet.create({
  hardwareInput: { position: "absolute", width: 1, height: 1, overflow: "hidden" },
  bottom: { bottom: space[12], left: space[12], position: "absolute", right: space[12] },
  card: {
    ...material.float,
    borderRadius: radius.lg,
    gap: space[8],
    padding: space[12] - (1 - StyleSheet.hairlineWidth),
  },
  dialog: {
    ...material.float,
    borderRadius: radius.xxl + space[4],
    gap: space[10],
    maxWidth: 320,
    paddingBottom: space[14],
    paddingHorizontal: space[18],
    paddingTop: space[18],
    width: "100%",
  },
  dialogActions: { flexDirection: "row", gap: space[8], marginTop: space[6] },
  dialogButton: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    flex: 1,
    justifyContent: "center",
    minHeight: touchTarget,
  },
  dialogFrom: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    justifyContent: "center",
  },
  dialogMessage: { textAlign: "center" },
  dialogPrimary: { backgroundColor: color.ember },
  dialogPrimaryText: { color: color.inkOnEmber },
  dialogScrim: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    justifyContent: "center",
    padding: space[24],
  },
  dim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0, 0, 0, 0.5)" },
  fitBand: { alignItems: "center", justifyContent: "center", position: "absolute" },
  fitChip: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    height: 40,
    paddingHorizontal: space[16],
  },
  fitGlyph: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  grow: { flex: 1, minWidth: 0 },
  iconButton: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  input: {
    ...material.control,
    ...textType.secondary,
    borderRadius: radius.md,
    color: color.text,
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  // A round control in the corner, clear of the page's own controls along its edges.
  keyboard: { bottom: space[12], position: "absolute", right: space[12], zIndex: 6 },
  keyboardFace: {
    alignItems: "center",
    height: touchTarget + space[4],
    justifyContent: "center",
    width: touchTarget + space[4],
  },
  arrival: { ...StyleSheet.absoluteFill },
  native: { flex: 1, minHeight: 0 },
  page: { flex: 1, minHeight: 0 },
  // Zoom grows the picture from its top-leading corner, where its offset is measured from.
  picture: { position: "absolute", top: 0, transformOrigin: "left top" },
  pressed: { opacity: 0.7 },
  row: { alignItems: "center", flexDirection: "row", gap: space[8] },
  stage: { backgroundColor: color.background, flex: 1, minHeight: 0, overflow: "hidden" },
  top: { gap: space[8], left: space[12], position: "absolute", right: space[12], top: space[12] },
  typingField: { flex: 1, minWidth: 0 },
  typingRound: { width: touchTarget },
  typingGlyph: { paddingEnd: space[4], paddingStart: space[14] },
});
