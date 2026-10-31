import { useActionReview } from "@opensteer/client/react";
import { ActionReviewSheet } from "../ui/action-review.js";
import {
  passkeyNotice,
  browserActingTabId,
  browserSiteForUrl,
  browserTabTitle,
  reviewHostAction,
  type BrowserTabOpenHandle,
  type BrowserCommand,
  type BrowserSessionSummary,
  type HostClient,
} from "@opensteer/client/host";
import { BrowserSurfaceIdSchema, type BrowserPageContentPart } from "@opensteer/core";
import { browserPromptTextMaxLength } from "@opensteer/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { EditingOperation } from "@opensteer/client/editing";
import type { EditingContext } from "@opensteer/protocol/editing";
import { createMobileBrowserEditing } from "./browser-editing.js";
import {
  NativeEditingProxy,
  type NativeEditingProxyHandle,
} from "../../modules/remote-text-input/src/editing-proxy.js";
import { LegacyInput } from "../../modules/remote-text-input/src/legacy-input.js";
import type { EditingTargetAbilities } from "@opensteer/client/editing";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space, touchTarget, type as textType } from "../theme.js";
import { AppText, Notice } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TextInput } from "../ui/text-input.js";
import { holdRemoteEditing, interact } from "../voice/interaction.js";
import { BrowserStream, submitBrowserCommand, useBrowserFeedState } from "./browser-stream.js";
import { ChromeSignInAction } from "./chrome-sign-in-action.js";
import { useSurfaceHeader, type SurfaceMenuItem } from "./surface-header.js";
import { pageSite, viewedPage } from "./surface-route.js";

/** The shape a page takes before its first picture says otherwise. */
const defaultPageAspect = 16 / 9;
/** A command the page refused: its feed went away after the view last drew. */
const refusedNotice = "The page is reconnecting. Try again in a moment.";

/**
 * One browser page above the conversation: the live picture, which a tap
 * clicks through and a drag scrolls, under a compact bar whose ⋯ holds
 * navigation, New tab, Fit and Close. The person and the agent use the page at
 * the same time; nothing here takes it from either.
 *
 * The picture is as tall as the page's own shape at this width, so it sits at
 * the top with no band above or below it and the conversation has the rest.
 * Where that is more than the screen has, it shrinks and fits by its height.
 *
 * Negotiated fields use the native editing proxy. Baseline sessions retain plain typing.
 * The address draft stays as the person left it when the page changes.
 */
export function BrowserPage(props: {
  /** In front of the reader, with the app in the foreground. */
  readonly active: boolean;
  readonly connected: boolean;
  readonly hostClient: HostClient;
  /** The page being read, whenever it changes, for the composer to include. */
  readonly onViewing: (page: BrowserPageContentPart | null) => void;
  /** The person is typing into the page, and the conversation should make room. */
  readonly onTyping: (typing: boolean) => void;
  readonly session: BrowserSessionSummary;
  readonly tabId: string;
  readonly editAddress: boolean;
  readonly onOpenTab: (opening: BrowserTabOpenHandle) => void;
  readonly onClosed: () => void;
  /** The browser's Workspace, whose agents may use a site once it is signed in. */
  readonly workspaceName: string;
}): ReactNode {
  const { hostClient, onTyping, onViewing, session, tabId } = props;
  const surfaceId = BrowserSurfaceIdSchema.parse(tabId);
  const dialog = session.dialog?.surfaceId === tabId ? session.dialog : null;
  const [prompt, setPrompt] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const promptText = prompt?.id === dialog?.id ? (prompt?.text ?? "") : "";
  const catalogTab = session.tabCatalog?.tabs.find((candidate) => candidate.id === tabId);
  const tab =
    session.tabs.find((candidate) => candidate.id === tabId) ??
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
  const area = useRef({ height: 0, width: 0 });
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
    const width = Math.round(area.current.width);
    const height = Math.round(area.current.height);
    return width > 0 && height > 0 ? { height, width } : null;
  };
  const navigate = () => {
    if (!ready) return;
    const address = (addressDraft ?? tab?.url ?? "").trim();
    let url: URL;
    try {
      url = new URL(
        address.includes("://") || address === "about:blank" ? address : `https://${address}`,
      );
    } catch {
      setProblem("Enter a valid website address.");
      return;
    }
    if (!["http:", "https:"].includes(url.protocol) && url.href !== "about:blank") {
      setProblem("Enter a valid website address.");
      return;
    }
    // The address stays as typed until the page has taken it.
    if (!send({ type: "navigation.go", url: url.href })) return;
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
      props.onOpenTab(hostClient.beginBrowserTabOpen({ sessionId: session.id }));
    } catch (error) {
      openingTab.current = false;
      setProblem(operationDetail(error, "A new tab could not be opened."));
    }
  };

  const site = tab ? pageSite(tab.url) : null;
  const title = tab ? browserTabTitle(tab) : "Page";
  const signInSite = session.state === "ready" && tab?.url ? browserSiteForUrl(tab.url) : null;
  useSurfaceHeader({
    acting: browserActingTabId(session) === tabId,
    glyph: "globe",
    menu: [
      {
        disabled: !ready,
        icon: "chevron.backward",
        id: "back",
        label: "Back",
        onPress: () => send({ type: "navigation.back" }),
      },
      {
        disabled: !ready,
        icon: "chevron.forward",
        id: "forward",
        label: "Forward",
        onPress: () => send({ type: "navigation.forward" }),
      },
      {
        disabled: !ready,
        icon: "arrow.clockwise",
        id: "reload",
        label: "Reload",
        onPress: () => send({ type: "navigation.reload" }),
      },
      {
        disabled: !channelReady,
        icon: "plus.square.on.square",
        id: "new-tab",
        label: "New tab",
        onPress: () => void openTab(),
      },
      {
        disabled: !ready || tab === undefined,
        icon: "arrow.up.left.and.arrow.down.right",
        hint: "Resize page to fit",
        id: "fit",
        label: "Fit page",
        onPress: () => {
          const size = viewport();
          if (tab !== undefined && size !== null)
            send({ type: "viewport.set", surfaceId: tab.id, ...size });
        },
      },
      ...(signInSite === null
        ? []
        : [
            {
              icon: "person.badge.key",
              id: "chrome",
              label: "Sign in with Chrome",
              onPress: () => setSigningIn(true),
            } satisfies SurfaceMenuItem,
          ]),
      {
        destructive: true,
        disabled: !props.connected || session.state !== "ready" || !tab,
        icon: "xmark.circle",
        id: "close",
        label: "Close tab",
        onPress: closeTab,
      },
    ],
    onTitlePress: () => setAddressOpen((open) => !open),
    secondary: site,
    title,
    titleHint: "Shows the page address",
  });

  const label = site === null ? title : `${title}, ${site}`;
  return (
    <View style={styles.page}>
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
      {addressOpen ? (
        <View style={styles.address}>
          <TextInput
            accessibilityLabel="Website address"
            accessibilityHint="Enter the address for this page"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            editable={closeReview === null}
            keyboardType="url"
            onChangeText={setAddressDraft}
            onSubmitEditing={navigate}
            placeholder="Search or enter address"
            placeholderTextColor={color.muted}
            returnKeyType="go"
            selectTextOnFocus
            style={[styles.input, styles.grow]}
            value={addressDraft ?? (tab?.url === "about:blank" ? "" : tab?.url) ?? ""}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            accessibilityHint="Keeps the current page address"
            hitSlop={space[6]}
            onPress={() => {
              setAddressDraft(null);
              setAddressOpen(false);
            }}
            style={styles.textButton}
          >
            <AppText role="secondaryMedium" tone="ember">
              Cancel
            </AppText>
          </Pressable>
        </View>
      ) : null}
      <View
        onLayout={(event) => {
          area.current = event.nativeEvent.layout;
        }}
        style={[styles.picture, { aspectRatio: aspect }]}
      >
        <BrowserStream
          active={props.active}
          tabId={tabId}
          hostClient={hostClient}
          interactive
          inputEnabled={closeReview === null}
          label={label}
          onPageSize={onPageSize}
          onPointerDown={() => proxy.current?.interrupt()}
          onScroll={() => setMayType(false)}
          onTap={() => {
            setTyping(false);
            setMayType(true);
          }}
          session={session}
        />
        {problem === null && !refused && !feed.inputError && dialog === null && !passkey ? null : (
          <View pointerEvents="box-none" style={styles.top}>
            {passkey ? (
              <View style={styles.card}>
                <AppText role="secondary">{passkeyNotice}</AppText>
              </View>
            ) : null}
            {problem !== null || refused ? (
              <Notice detail={problem ?? refusedNotice} title="Page unavailable" tone="neutral" />
            ) : feed.inputError ? (
              // The page refused a touch or key, and says why; the next one clears it.
              <Notice detail={feed.inputError} title="That didn’t reach the page" tone="neutral" />
            ) : null}
            {dialog === null ? null : (
              <View style={styles.card}>
                <AppText role="secondary">{dialog.message}</AppText>
                {dialog.type === "prompt" ? (
                  <TextInput
                    accessibilityLabel="Your answer"
                    editable={channelReady}
                    key={dialog.id}
                    maxLength={browserPromptTextMaxLength}
                    onChangeText={(text) => setPrompt({ id: dialog.id, text })}
                    value={promptText}
                    style={styles.input}
                  />
                ) : null}
                <View style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                    accessibilityHint="Dismisses this page’s dialog"
                    onPress={() =>
                      send({ type: "dialog.respond", accept: false, dialogId: dialog.id })
                    }
                    style={styles.textButton}
                  >
                    <AppText role="secondaryMedium" tone="soft">
                      Cancel
                    </AppText>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="OK"
                    accessibilityHint="Accepts this page’s dialog"
                    onPress={() =>
                      send({
                        type: "dialog.respond",
                        accept: true,
                        dialogId: dialog.id,
                        ...(dialog.type === "prompt" ? { promptText } : {}),
                      })
                    }
                    style={styles.textButton}
                  >
                    <AppText role="secondaryMedium" tone="ember">
                      OK
                    </AppText>
                  </Pressable>
                </View>
              </View>
            )}
          </View>
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
        ) : typing && ready && editable && tab !== undefined ? (
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
        ) : mayType && ready && editable ? (
          <Pressable
            accessibilityHint="Types into the page"
            accessibilityLabel="Keyboard"
            accessibilityRole="button"
            onPress={() => {
              interact();
              setTyping(true);
            }}
            style={({ pressed }) => [styles.keyboard, pressed && styles.pressed]}
          >
            <Symbol name="keyboard" size={18} tint={color.text} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** The page keyboard uses the same proxy as phone and Mac take-over. */
export function PageTyping(props: {
  readonly onDone: () => void;
  readonly context: EditingContext | null;
  readonly sendOperation: (operation: EditingOperation) => boolean;
  readonly abilities?: EditingTargetAbilities;
  readonly legacy?: boolean;
  readonly ref?: Ref<NativeEditingProxyHandle>;
}): ReactNode {
  useLayoutEffect(holdRemoteEditing, []);
  return (
    <View style={[styles.typing, styles.bottom]}>
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Done"
        accessibilityHint="Closes the page keyboard"
        hitSlop={space[6]}
        onPress={props.onDone}
        style={styles.textButton}
      >
        <AppText role="secondaryMedium" tone="ember">
          Done
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  address: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    paddingHorizontal: space[12],
    paddingVertical: space[6],
  },
  bottom: { bottom: space[12], left: space[12], position: "absolute", right: space[12] },
  card: {
    backgroundColor: color.surfaceElevated,
    borderColor: color.lineStrong,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[8],
    padding: space[12],
  },
  grow: { flex: 1, minWidth: 0 },
  iconButton: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  input: {
    ...textType.secondary,
    backgroundColor: color.surfaceRaised,
    borderColor: color.lineControl,
    borderRadius: radius.md,
    borderWidth: 1,
    color: color.text,
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  // A round control in the corner, clear of the page's own controls along its edges.
  keyboard: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    borderColor: color.lineStrong,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: space[16],
    elevation: 6,
    height: 48,
    justifyContent: "center",
    position: "absolute",
    right: space[16],
    shadowColor: "#000",
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    width: 48,
  },
  // Its own height, given up from the picture first when the screen is short.
  page: { flexShrink: 1, minHeight: 0 },
  picture: { flexShrink: 1, minHeight: 0, width: "100%" },
  pressed: { opacity: 0.7 },
  row: { alignItems: "center", flexDirection: "row", gap: space[8] },
  textButton: { justifyContent: "center", minHeight: touchTarget, paddingHorizontal: space[6] },
  top: { gap: space[8], left: space[12], position: "absolute", right: space[12], top: space[12] },
  typing: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    borderColor: color.lineStrong,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[8],
    padding: space[8],
  },
});
