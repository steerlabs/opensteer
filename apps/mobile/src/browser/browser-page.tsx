import { useActionReview } from "@opensteer/client/react";
import { ActionReviewSheet } from "../ui/action-review.js";
import {
  passkeyNotice,
  browserActingTabId,
  browserSiteForUrl,
  browserTabTitle,
  parseNavigationInput,
  reviewHostAction,
  webSearchUrl,
  type BrowserTabOpenHandle,
  type BrowserCommand,
  type BrowserSessionSummary,
  type HostClient,
} from "@opensteer/client/host";
import { BrowserSurfaceIdSchema, type BrowserPageContentPart } from "@opensteer/core";
import { browserPromptTextMaxLength, browserViewportFits } from "@opensteer/protocol";
import * as Clipboard from "expo-clipboard";
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
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { EditingOperation } from "@opensteer/client/editing";
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
import { appear, duration, exit } from "../ui/motion.js";
import { AppText, Notice } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { AddressCapsule, AddressEditor, type OpenTabSuggestion } from "./address-bar.js";
import { BrowserStream, submitBrowserCommand, useBrowserFeedState } from "./browser-stream.js";
import { ChromeSignInAction } from "./chrome-sign-in-action.js";
import { pageSite, viewedPage } from "./surface-route.js";
import { Toolbar, ToolbarButton, ToolbarCapsule, ToolbarMenu } from "./toolbar.js";

/** The shape a page takes before its first picture says otherwise. */
const defaultPageAspect = 16 / 9;
/** A command the page refused: its feed went away after the view last drew. */
const refusedNotice = "The page is reconnecting. Try again in a moment.";
/** Where a page's bar moves from under it to over it, as Safari's does on iPad. */
const regularWidth = 600;
/** Room left under a page narrower than its place that is worth offering Fit for. */
const fitBand = 0.15;

/**
 * One browser page, used as Safari is used on a phone: the page as large as
 * its place allows, and under it one bar with Back, the address, the tabs and
 * ⋯. Where the page has a regular width the bar sits over it instead and
 * Forward joins Back, as Safari on iPad has it.
 *
 * The page is drawn at its own shape, as wide as its place and pinned to the
 * top; a page taller than the room fits by its height. It is never resized by
 * being looked at — only Fit resizes it, to exactly its place — and a page a
 * desktop left wide offers Fit in the room under it.
 *
 * Tapping a field the page reports opens the keyboard at once, and the page
 * slides up so the caret stays in view over it rather than shrinking. The
 * person and the agent use the page at the same time; nothing here takes it
 * from either.
 */
export function BrowserPage(props: {
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
}): ReactNode {
  const { hostClient, onSwitchTab, onTyping, onViewing, session, tabId } = props;
  const surfaceId = BrowserSurfaceIdSchema.parse(tabId);
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
  const [problem, setProblem] = useState<string | null>(null);
  const [addressOpen, setAddressOpen] = useState(props.editAddress);
  // Null shows the page's own address; anything else is the person's, kept
  // until they go there or put it away.
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const proxy = useRef<NativeEditingProxyHandle>(null);
  const [mayType, setMayType] = useState(false);
  const [typing, setTyping] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const openingTab = useRef(false);
  useEffect(() => () => onTyping(false), [onTyping]);
  const [aspect, setAspect] = useState(defaultPageAspect);
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
    if (!props.active || !props.connected) {
      setTyping(false);
      return;
    }
    return editing.activate((message) => {
      setProblem(message);
      if (!editing.get().negotiated) setTyping(false);
    });
  }, [editing, props.active, props.connected]);
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

  const viewed = tab === undefined ? null : viewedPage(session, tab);
  const viewedKey =
    viewed === null ? null : `${viewed.tabId}\u0000${viewed.url}\u0000${viewed.title}`;
  const latestViewed = useRef(viewed);
  latestViewed.current = viewed;
  useEffect(() => {
    onViewing(latestViewed.current);
  }, [onViewing, viewedKey]);
  useEffect(() => () => onViewing(null), [onViewing]);
  useEffect(() => onTyping(typing || addressOpen), [addressOpen, onTyping, typing]);

  // The page's place: its width, whether it is regular, and the room it rests
  // in. The resting room is kept while the keyboard is up, so the page keeps
  // its size and slides instead of shrinking under it.
  const [width, setWidth] = useState(0);
  const regular = width >= regularWidth;
  const [room, setRoom] = useState({ height: 0, width: 0 });
  const [visibleHeight, setVisibleHeight] = useState(0);
  const lifted = typing || addressOpen;
  const onStage = (event: LayoutChangeEvent) => {
    const { height, width: stageWidth } = event.nativeEvent.layout;
    setVisibleHeight(height);
    if (!lifted)
      setRoom((current) =>
        current.height === height && current.width === stageWidth
          ? current
          : { height, width: stageWidth },
      );
  };
  const picture = pictureBox(room, aspect);

  // A refusal belongs to the feed admission it met; the next admission has recovered.
  const [refusedAdmission, setRefusedAdmission] = useState<string | null>(null);
  const refused = refusedAdmission !== null && refusedAdmission === feed.admissionId;
  const send = (command: BrowserCommand): boolean => {
    if (!ready) return false;
    const targeted = { ...command, surfaceId };
    const taken = submitBrowserCommand(hostClient, session.id, targeted);
    if (!taken) setRefusedAdmission(feed.admissionId ?? null);
    return taken;
  };
  latestSend.current = send;
  const viewport = () => {
    const size = { height: Math.round(room.height), width: Math.round(room.width) };
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

  const navigationProblem =
    tab?.navigationFailed || catalogTab?.navigationFailed
      ? "This page could not be loaded. Reload to try again."
      : null;
  const pageProblem = problem ?? navigationProblem;
  const site = tab ? pageSite(tab.url) : null;
  const title = tab ? browserTabTitle(tab) : "Page";
  const signInSite = session.state === "ready" && tab?.url ? browserSiteForUrl(tab.url) : null;
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
    Math.abs(picture.width - room.width) <= 2 &&
    Math.abs(picture.height - room.height) <= 2;
  const bandBelow = room.height - picture.height;
  const offerFit =
    ready &&
    tab !== undefined &&
    !lifted &&
    picture.height > 0 &&
    bandBelow > room.height * fitBand;

  const menu: NativeMenuSection[] = [
    [
      ...(regular
        ? []
        : [
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
            label: Platform.OS === "ios" ? "Open in Safari" : "Open in browser",
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

  const bar = (
    <Toolbar edge={regular ? "top" : "bottom"} testID="page-toolbar">
      <ToolbarButton
        disabled={!ready || !canGoBack}
        label="Back"
        onPress={() => void send({ type: "navigation.back" })}
        symbol="chevron.left"
      />
      {regular ? (
        <ToolbarButton
          disabled={!ready || !canGoForward}
          label="Forward"
          onPress={() => void send({ type: "navigation.forward" })}
          symbol="chevron.right"
        />
      ) : null}
      <AddressCapsule
        acting={acting}
        favicon={liveTab?.favicon ?? null}
        loading={loading}
        onEdit={() => setAddressOpen(true)}
        onReload={() => void send({ type: "navigation.reload" })}
        onSwitch={canSwitch ? switchBy : null}
        reloadable={ready}
        secure={tab?.url.startsWith("https://") === true}
        site={site}
      />
      <ToolbarButton
        accessibilityHint="Shows this browser’s tabs"
        count={tabs.length}
        label={`Tabs, ${tabs.length}`}
        onPress={props.onShowTabs}
      />
      <ToolbarMenu label="More" sections={menu} symbol="ellipsis" title={title} />
    </Toolbar>
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
      under={regular}
    />
  );
  const keyboardOpen = typing && ready && editable && tab !== undefined;

  const slide = useSharedValue(0);
  const caret = editingState.context?.caret ?? null;
  const slideTo = keyboardOpen ? slideFor(caret, picture.height, visibleHeight) : 0;
  useEffect(() => {
    slide.value = withTiming(slideTo, { duration: duration.enter });
  }, [slide, slideTo]);
  const slid = useAnimatedStyle(() => ({ transform: [{ translateY: slide.value }] }));

  const label = site === null ? title : `${title}, ${site}`;
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
      {regular ? (addressOpen ? editor : bar) : null}
      <View onLayout={onStage} style={styles.stage}>
        <Animated.View
          style={[
            styles.picture,
            { height: picture.height, left: picture.left, width: picture.width },
            slid,
          ]}
        >
          <BrowserStream
            active={props.active}
            tabId={tabId}
            hostClient={hostClient}
            interactive
            inputEnabled={closeReview === null && !addressOpen}
            label={label}
            onPageSize={onPageSize}
            onPointerDown={() => proxy.current?.interrupt()}
            onScroll={() => setMayType(false)}
            onTap={() => {
              // A page that reports its fields keeps the keyboard up from one
              // field to the next and puts it away when nothing has focus.
              if (!editing.get().negotiated) setTyping(false);
              setMayType(true);
            }}
            session={session}
          />
        </Animated.View>
        {offerFit ? (
          <Animated.View
            entering={appear}
            exiting={exit}
            pointerEvents="box-none"
            style={[styles.fitBand, { height: bandBelow, top: picture.height }]}
          >
            <Pressable
              accessibilityHint="Resizes the page to fill your screen"
              accessibilityLabel="Fit to screen"
              accessibilityRole="button"
              onPress={fit}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <GlassSurface interactive shape="capsule" style={styles.fitChip}>
                <Symbol
                  name="arrow.up.left.and.arrow.down.right"
                  size={14}
                  tint={color.ember}
                  weight="semibold"
                />
                <AppText role="secondaryMedium">Fit to screen</AppText>
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
        {pageProblem === null && !refused && !feed.inputError && !passkey ? null : (
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
              <Notice detail={feed.inputError} title="That didn’t reach the page" tone="neutral" />
            ) : null}
          </View>
        )}
        {dialog === null ? null : (
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
        )}
        {signingIn && signInSite !== null && tab !== undefined ? (
          <View style={[styles.card, styles.bottom]}>
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
          <Animated.View entering={appear} exiting={exit} style={styles.keyboard}>
            <Pressable
              accessibilityHint="Types into the page"
              accessibilityLabel="Keyboard"
              accessibilityRole="button"
              onPress={() => setTyping(true)}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <GlassSurface interactive shape="capsule" style={styles.keyboardFace}>
                <Symbol name="keyboard" size={19} tint={color.text} />
              </GlassSurface>
            </Pressable>
          </Animated.View>
        ) : null}
      </View>
      {keyboardOpen ? (
        <PageTyping
          ref={proxy}
          onDone={() => {
            setTyping(false);
            setMayType(false);
          }}
          context={editingState.context}
          abilities={editingState.abilities}
          legacy={!editingState.negotiated}
          sendOperation={(operation) => editing.send(operation)}
        />
      ) : regular ? null : addressOpen ? (
        editor
      ) : (
        bar
      )}
    </View>
  );
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
  if (room.width <= 0 || room.height <= 0 || !(aspect > 0)) return { height: 0, left: 0, width: 0 };
  const byWidth = room.width / aspect;
  if (byWidth <= room.height) return { height: byWidth, left: 0, width: room.width };
  const width = room.height * aspect;
  return { height: room.height, left: (room.width - width) / 2, width };
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
 * and Mac take-over.
 */
export function PageTyping(props: {
  readonly onDone: () => void;
  readonly context: EditingContext | null;
  readonly sendOperation: (operation: EditingOperation) => boolean;
  readonly abilities?: EditingTargetAbilities;
  readonly legacy?: boolean;
  readonly ref?: Ref<NativeEditingProxyHandle>;
}): ReactNode {
  return (
    <Toolbar edge="bottom" testID="page-typing">
      <ToolbarCapsule style={styles.typingField}>
        <View style={styles.typingGlyph}>
          <Symbol name="keyboard" size={16} tint={color.muted} />
        </View>
        {props.legacy ? (
          <LegacyInput sendOperation={props.sendOperation} onDone={props.onDone} />
        ) : (
          <NativeEditingProxy
            ref={props.ref ?? null}
            context={props.context}
            sendOperation={props.sendOperation}
            onDone={props.onDone}
            {...(props.abilities ? { abilities: props.abilities } : {})}
          />
        )}
      </ToolbarCapsule>
      <ToolbarButton label="Done" onPress={props.onDone} selected symbol="checkmark" />
    </Toolbar>
  );
}

const styles = StyleSheet.create({
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
  fitBand: {
    alignItems: "center",
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
  },
  fitChip: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    height: 40,
    paddingHorizontal: space[16],
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
  page: { flex: 1, minHeight: 0 },
  picture: { position: "absolute", top: 0 },
  pressed: { opacity: 0.7 },
  row: { alignItems: "center", flexDirection: "row", gap: space[8] },
  stage: { backgroundColor: color.background, flex: 1, minHeight: 0, overflow: "hidden" },
  top: { gap: space[8], left: space[12], position: "absolute", right: space[12], top: space[12] },
  typingField: { flex: 1, minWidth: 0 },
  typingGlyph: { paddingEnd: space[4], paddingStart: space[14] },
});
