import {
  phonePlaceKey,
  type HostClient,
  type HostSnapshot,
  type NativeViewerSource,
} from "@opensteer/client/host";
import {
  computerUseStops,
  computerReasonWords,
  ownerViewComputerReadiness,
  computerDisplayScope,
  computerDisplayAuthorityKey,
  computerDisplayStatus,
  sharedDisplayStreams,
  type DisplayFrame,
  type DisplaySnapshot,
  type DisplayLease,
} from "@opensteer/client/integrations";
import { useHostSelector, usePlaceList } from "@opensteer/client/react";
import {
  displayViewerCloseCodes,
  displayViewerWindowFrames,
  type ComputerAppIdentity,
  type ComputerUseSessionSummary,
} from "@opensteer/protocol";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  PixelRatio,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { workspaceRoute } from "../browser/surface-route.js";
import { MacAppIcon } from "./app-mark.js";
import { openAppOwnerView, openPhoneOwnerView } from "./open-owner-view.js";
import { Toolbar, ToolbarButton, ToolbarCapsule, ToolbarMenu } from "../browser/toolbar.js";
import { color, controlFontScaleLimit, radius, space } from "../theme.js";
import type { NativeMenuOption, NativeMenuSection } from "../thread/composer-menu.js";
import { GlassSurface } from "../ui/glass.js";
import { AppText, SecondaryButton } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import {
  DisplayControls,
  type DisplayPicture,
  type DisplayControlsHandle,
} from "./display-input.js";

import {
  NativeDisplay,
  macWindowVideoSupported,
  phoneDisplayBinary,
  type DisplayFrameMetadata,
  type NativeDecoder,
} from "./phone-display-native.js";

/**
 * Hands one frame to the native decoder: the bytes themselves where the
 * binary takes them, otherwise standard base64 for a binary that predates it.
 */
export function decodeDisplayFrame(
  native: NativeDecoder,
  binary: boolean,
  payload: Uint8Array,
  metadata: DisplayFrameMetadata,
): Promise<boolean> {
  if (binary && native.decodeBytes) return native.decodeBytes(payload, metadata);
  const raw = encodeBase64Url(payload).replace(/-/g, "+").replace(/_/g, "/");
  return native.decode({ ...metadata, data: raw + "=".repeat((4 - (raw.length % 4)) % 4) });
}

/**
 * What a full viewer shows under the picture: the place's own bar, as a
 * page's is. A tile's preview has none.
 */
export interface ComputerBar {
  /** The Mac app shown, whose own icon names it; absent for a phone. */
  readonly app?: ComputerAppIdentity | undefined;
  /** The Mac an app is on; null for a phone, whose own name is the title. */
  readonly detail: string | null;
  readonly menu: NativeMenuSection;
  /** The keyboard is up for the display, and its pane should make room. */
  readonly onTyping: (typing: boolean) => void;
  readonly title: string;
}

/** A native surface consumes the shared transport's exact task authority; it never asks for a screenshot. */
export function ComputerDisplay({
  active,
  bar,
  hostClient,
  source: reference,
  phone,
  label,
  machineId,
  onPageSize,
  interactive = false,
  onReopen,
  preserveLastFrame = false,
}: {
  readonly bar?: ComputerBar | undefined;
  readonly onReopen?: (() => void) | undefined;
  readonly active: boolean;
  readonly interactive?: boolean;
  readonly preserveLastFrame?: boolean;
  readonly hostClient: HostClient;
  readonly source: NativeViewerSource;
  readonly phone: boolean;
  readonly label: string;
  readonly machineId?: string;
  readonly onPageSize?: ((size: { width: number; height: number }) => void) | undefined;
}) {
  const unavailable = !phone && !macWindowVideoSupported();
  const kind = reference.kind;
  const sessionId = reference.kind === "task-session" ? reference.sessionId : "";
  const appKey = reference.kind === "task-session" ? reference.appKey : undefined;
  const viewId = reference.kind === "owner-view" ? reference.viewId : "";
  const generation = reference.kind === "owner-view" ? reference.generation : 0;
  const source = useMemo<NativeViewerSource>(
    () =>
      kind === "task-session"
        ? { kind, sessionId, ...(appKey === undefined ? {} : { appKey }) }
        : { kind, viewId, generation },
    [kind, sessionId, appKey, viewId, generation],
  );
  const controls = useRef<DisplayControlsHandle>(null);
  const [canType, setCanType] = useState(false);
  const [displayState, setDisplayState] = useState<DisplaySnapshot | null>(null);
  const [inputLease, setInputLease] = useState<DisplayLease | null>(null);
  const [picture, setPicture] = useState<DisplayPicture | null>(null);
  const decodingPicture = useRef<DisplayPicture | null>(null);
  const decoder = useRef<NativeDecoder | null>(null);
  const [binary] = useState(phoneDisplayBinary);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [words, setWords] = useState<string | null>("Connecting…");
  const [shown, setShown] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const viewport = useRef(1280);
  const viewportChanged = useRef<((size: number) => void) | null>(null);
  const [startingSlow, setStartingSlow] = useState(false);
  useEffect(() => {
    setStartingSlow(false);
    if (shown || !active) return;
    const timer = setTimeout(() => setStartingSlow(true), 5_000);
    return () => clearTimeout(timer);
  }, [shown, active]);
  const reopen = useRef<(() => void) | null>(null);
  const epoch = useRef(0);
  const requestKeyframe = useRef<(() => void) | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const resetDecoder = useCallback((next: number, keepPicture = false) => {
    const native = decoder.current;
    if (!native) return;
    if (keepPicture && !native.resetKeepingPicture) {
      setPicture(null);
      setShown(false);
    }
    const reset =
      keepPicture && native.resetKeepingPicture
        ? native.resetKeepingPicture(String(next))
        : native.reset(String(next));
    void reset.catch(() => {
      // Native teardown already clears its surface. A bridge call queued before
      // removal can reject after that view's tag is gone.
      if (!mounted.current || decoder.current !== native || epoch.current !== next) return;
      setShown(false);
      setWords("Video sharing is unavailable");
    });
  }, []);
  const selectScope = useCallback(
    (snapshot: HostSnapshot) => computerDisplayScope(snapshot, source),
    [source],
  );
  const scope = useHostSelector(hostClient, selectScope);
  const preserve = preserveLastFrame && !interactive;
  const selectAuthority = useCallback(
    (snapshot: HostSnapshot) => computerDisplayAuthorityKey(snapshot, source, machineId),
    [source, machineId],
  );
  const authorityKey = useHostSelector(hostClient, selectAuthority);
  const sourceKey = JSON.stringify(source);
  const pictureKey =
    preserve && source.kind === "task-session"
      ? JSON.stringify([machineId, source.appKey ?? "main"])
      : sourceKey;
  const identity = useRef({ hostClient, pictureKey, authorityKey });
  useLayoutEffect(() => {
    const previous = identity.current;
    identity.current = { hostClient, pictureKey, authorityKey };
    if (
      previous.hostClient !== hostClient ||
      previous.pictureKey !== pictureKey ||
      previous.authorityKey !== authorityKey
    ) {
      setPicture(null);
      decodingPicture.current = null;
      setShown(false);
      resetDecoder(++epoch.current);
    }
  }, [hostClient, pictureKey, authorityKey, resetDecoder]);
  useLayoutEffect(
    () =>
      hostClient.subscribe(() => {
        if (
          computerDisplayAuthorityKey(hostClient.getSnapshot(), source, machineId) === authorityKey
        )
          return;
        setPicture(null);
        decodingPicture.current = null;
        setShown(false);
        resetDecoder(++epoch.current);
      }),
    [hostClient, source, machineId, authorityKey, resetDecoder],
  );
  useVisibleOwnerRetention(hostClient, source, active && foreground && scope !== null);
  const updateName = useHostSelector(
    hostClient,
    (snapshot) =>
      snapshot.machines.find(
        (machine) =>
          (machine.status === "needs-update" ||
            machine.status === "updating" ||
            machine.status === "update-pending") &&
          (machine.id === machineId ||
            machine.computerUse?.sessions.some((session) => session.sessionId === sessionId)),
      )?.detail ?? null,
  );
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => listener.remove();
  }, []);
  useLayoutEffect(() => {
    if (unavailable || !active || !foreground || !scope || authorityKey === null) {
      const keepPicture = preserve && active && foreground && authorityKey !== null;
      if (!keepPicture) {
        setShown(false);
      }
      resetDecoder(++epoch.current, keepPicture);
      return;
    }
    const pool = sharedDisplayStreams(hostClient);
    const lease = pool.retain({ scope, source, ...(interactive ? { editing: 1 as const } : {}) });
    setInputLease(lease);
    reopen.current = () =>
      pool.reopen({ scope, source, ...(interactive ? { editing: 1 as const } : {}) });
    requestKeyframe.current = () => lease.requestKeyframe();
    let disposed = false;
    let connection = -1;
    let generation = -1;
    let submitting = 0;
    const queued: { frame: DisplayFrame; epoch: number }[] = [];
    let bytes = 0;
    let awaitingKey = false;
    const pending = new Set<DisplayFrame>();
    const clear = (keepPicture = false) => {
      epoch.current++;
      decodingPicture.current = null;
      if (!keepPicture) {
        setPicture(null);
        setShown(false);
      }
      resetDecoder(epoch.current, keepPicture);
      generation = -1;
      for (const frame of pending) frame.done();
      pending.clear();
      queued.length = 0;
      bytes = 0;
    };
    const changed = () => {
      const snapshot = lease.getSnapshot();
      setDisplayState(snapshot);
      const status = computerDisplayStatus(snapshot, phone);
      setWords(
        status.reason
          ? computerReasonWords(status.reason, { machine: label, target: label, phone })
          : null,
      );
      setTerminal(snapshot.connection === "closed");
      if (
        snapshot.connection === "closed" ||
        snapshot.closeCode === displayViewerCloseCodes.loginEnded ||
        (!preserve && snapshot.connection === "connecting") ||
        (snapshot.display && !["starting", "live"].includes(snapshot.display.state))
      )
        clear();
    };
    const unsubscribe = lease.subscribe(changed);
    const invalidate = hostClient.subscribe(() => {
      if (computerDisplayScope(hostClient.getSnapshot(), source) === scope) return;
      if (
        preserve &&
        computerDisplayAuthorityKey(hostClient.getSnapshot(), source, machineId) === authorityKey
      )
        return;
      clear();
      pool.invalidate(
        (target) => computerDisplayScope(hostClient.getSnapshot(), target.source) === target.scope,
      );
    });
    const submit = () => {
      // Invocation order is decode order. Replies may settle out of order;
      // DisplayStreams returns credit only after all earlier frames are done.
      while (!disposed && submitting < 4 && queued.length > 0) {
        const { frame, epoch: current } = queued.shift()!;
        if (current !== epoch.current) continue;
        submitting++;
        const native = decoder.current;
        const { width, height, ptsUs, key } = frame.header;
        decodingPicture.current = { generation: frame.header.generation, width, height };
        let result: Promise<boolean>;
        try {
          result = native
            ? decodeDisplayFrame(native, binary, frame.payload, {
                epoch: String(current),
                width,
                height,
                pts: ptsUs,
                key,
                replayed: frame.replayed,
              })
            : Promise.resolve(false);
        } catch {
          result = Promise.resolve(false);
        }
        void result
          .then(
            (accepted) => {
              if (!accepted && !disposed && current === epoch.current) lease.requestKeyframe();
            },
            () => {
              if (!disposed && current === epoch.current) lease.requestKeyframe();
            },
          )
          .finally(() => {
            submitting--;
            if (pending.delete(frame)) bytes -= frame.payload.byteLength;
            frame.done();
            submit();
          });
      }
    };
    const frames = lease.onFrame((frame) => {
      const state = lease.getSnapshot();
      if (
        disposed ||
        state.connection === "closed" ||
        (state.display && !["starting", "live"].includes(state.display.state))
      ) {
        frame.done();
        return;
      }
      if (connection !== frame.connection || generation !== frame.header.generation) {
        if (!frame.header.key) {
          frame.done();
          lease.requestKeyframe();
          return;
        }
        clear(preserve);
        connection = frame.connection;
        generation = frame.header.generation;
      }
      // A dropped frame breaks the reference chain, so nothing but a key follows it.
      if (awaitingKey && !frame.header.key) {
        frame.done();
        return;
      }
      if (
        pending.size >=
          (frame.replayed
            ? 600
            : state.display?.displayWindow === 1
              ? displayViewerWindowFrames
              : 4) ||
        (pending.size > 0 && bytes + frame.payload.byteLength > 1_048_576)
      ) {
        frame.done();
        awaitingKey = true;
        lease.requestKeyframe();
        return;
      }
      awaitingKey = false;
      pending.add(frame);
      bytes += frame.payload.byteLength;
      queued.push({ frame, epoch: epoch.current });
      submit();
    });
    viewportChanged.current = phone ? null : (size) => lease.viewport(size);
    if (!phone) lease.viewport(viewport.current);
    changed();
    return () => {
      controls.current?.resetInput();
      setInputLease(null);
      setDisplayState(null);
      viewportChanged.current = null;
      disposed = true;
      requestKeyframe.current = null;
      frames();
      unsubscribe();
      invalidate();
      const next = identity.current;
      clear(
        preserve &&
          mounted.current &&
          next.hostClient === hostClient &&
          next.pictureKey === pictureKey &&
          next.authorityKey === authorityKey &&
          authorityKey !== null,
      );
      lease.release();
    };
  }, [
    active,
    foreground,
    hostClient,
    resetDecoder,
    scope,
    source,
    label,
    phone,
    unavailable,
    interactive,
    binary,
    preserve,
    authorityKey,
    machineId,
    sourceKey,
  ]);
  const navigable =
    interactive && phone && inputLease !== null && shown && displayState?.input === "available";
  const go = (to: "back" | "home" | "recents") => {
    if (picture !== null) inputLease?.input(picture.generation, [{ kind: "nav", to }]);
  };
  const power = displayState?.power === "available" ? displayState.display?.state : null;
  const stage = (
    <View
      accessibilityLabel={label}
      style={styles.stage}
      onLayout={({ nativeEvent }) => {
        const { width, height } = nativeEvent.layout;
        viewport.current = Math.max(width, height) * PixelRatio.get();
        viewportChanged.current?.(viewport.current);
      }}
    >
      <NativeDisplay
        ref={decoder}
        style={StyleSheet.absoluteFill}
        onNeedsKeyframe={({ nativeEvent }) => {
          if (nativeEvent.epoch !== String(epoch.current)) return;
          if (nativeEvent.pictureGone) {
            controls.current?.resetInput();
            setPicture(null);
            setShown(false);
          }
          requestKeyframe.current?.();
        }}
        onReady={({ nativeEvent }) => {
          if (nativeEvent.epoch !== String(epoch.current) || !active || !foreground || !scope)
            return;
          setShown(true);
          setPicture(decodingPicture.current);
          onPageSize?.({ width: nativeEvent.width, height: nativeEvent.height });
        }}
      />
      {interactive && inputLease && !unavailable ? (
        <DisplayControls
          key={scope}
          ref={controls}
          lease={inputLease}
          onCanType={setCanType}
          {...(bar === undefined ? {} : { onTyping: bar.onTyping })}
          picture={picture}
          phone={phone}
          visible={active && foreground && shown && !words}
        />
      ) : null}
      {interactive && phone && active && foreground && displayState?.input !== "available" ? (
        <GlassSurface shape="capsule" style={styles.badge}>
          <Symbol name="eye" size={13} tint={color.textSoft} />
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="soft">
            View only
          </AppText>
        </GlassSurface>
      ) : null}
      {unavailable || !shown || (!preserve && (words || updateName !== null)) ? (
        <View style={styles.status}>
          {!unavailable && !words && updateName === null ? (
            <ActivityIndicator color={color.muted} />
          ) : null}
          <AppText role="secondary" style={styles.statusText} tone="soft">
            {unavailable
              ? "Mac window video is unavailable on iOS in this release."
              : updateName !== null
                ? updateName
                : (words ??
                  (phone
                    ? `Connecting to ${label}…`
                    : startingSlow
                      ? "macOS is taking longer to start sharing this window."
                      : "Starting window sharing…"))}
          </AppText>
          {interactive && phone && power === "screen-off" ? (
            <SecondaryButton label="Wake phone" onPress={() => inputLease?.power("wake")} />
          ) : null}
          {terminal && (!phone || onReopen) && !unavailable ? (
            <SecondaryButton
              label={phone ? "Reopen" : "Open again"}
              onPress={() => (onReopen ? onReopen() : reopen.current?.())}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
  if (bar === undefined) return stage;
  const menu: NativeMenuSection[] = [
    interactive && phone && power === "live"
      ? [
          {
            icon: "lock",
            id: "lock",
            label: "Lock phone",
            onPress: () => inputLease?.power("lock"),
          },
        ]
      : [],
    bar.menu,
  ];
  return (
    <View style={styles.viewer}>
      {stage}
      <Toolbar edge="bottom" testID="display-toolbar">
        {interactive && phone ? (
          <GlassSurface interactive shape="capsule" style={styles.keys}>
            {(["back", "home", "recents"] as const).map((to) => (
              <Pressable
                accessibilityLabel={to === "back" ? "Back" : to === "home" ? "Home" : "Recent apps"}
                accessibilityRole="button"
                accessibilityState={{ disabled: !navigable }}
                disabled={!navigable}
                key={to}
                onPress={() => go(to)}
                style={({ pressed }) => [styles.key, pressed && styles.pressed]}
              >
                <Symbol
                  name={to === "back" ? "chevron.left" : to === "home" ? "circle" : "square"}
                  size={to === "back" ? 18 : 15}
                  tint={navigable ? color.text : color.mutedDim}
                  weight="semibold"
                />
              </Pressable>
            ))}
          </GlassSurface>
        ) : null}
        <ToolbarCapsule style={styles.name}>
          {bar.app !== undefined && machineId !== undefined ? (
            <MacAppIcon app={bar.app} hostClient={hostClient} machineId={machineId} size={22} />
          ) : (
            <Symbol name={phone ? "smartphone" : "laptopcomputer"} size={15} tint={color.muted} />
          )}
          <View style={styles.nameWords}>
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="secondaryMedium"
            >
              {bar.title}
            </AppText>
            {bar.detail === null ? null : (
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="caption"
                tone="muted"
              >
                {bar.detail}
              </AppText>
            )}
          </View>
        </ToolbarCapsule>
        {interactive ? (
          <ToolbarButton
            accessibilityHint={`Types into the ${phone ? "phone" : "app"}`}
            disabled={!canType}
            label="Keyboard"
            onPress={() => controls.current?.startTyping()}
            symbol="keyboard"
          />
        ) : null}
        {menu.some((section) => section.length > 0) ? (
          <ToolbarMenu label="More" sections={menu} symbol="ellipsis" title={bar.title} />
        ) : null}
      </Toolbar>
    </View>
  );
}
export function ComputerTaskView(props: {
  readonly appKey: string | null;
  readonly active: boolean;
  readonly onTyping: (typing: boolean) => void;
  readonly hostClient: HostClient;
  readonly computerSessionId: string;
  readonly machineId: string;
}) {
  const machine = useHostSelector(props.hostClient, (snapshot) =>
    snapshot.machines.find((value) => value.id === props.machineId),
  );
  const session = machine?.computerUse?.sessions.find(
    (value) => value.sessionId === props.computerSessionId,
  );
  const phone = props.appKey === null;
  const machineName = machine?.name ?? (phone ? "Your phone" : "Your Mac");
  const app = session?.apps.find((app) => app.bundleId.toLowerCase() === props.appKey);
  const windowTitle = session?.windows?.find((window) => window.appKey === props.appKey)?.title;
  const label = phone
    ? machineName
    : [app?.displayName ?? "This app", windowTitle].filter(Boolean).join(" — ");
  return machine &&
    (machine.status === "needs-update" ||
      machine.status === "updating" ||
      machine.status === "update-pending") ? (
    <View style={styles.stage}>
      <AppText>{machine.detail ?? `Update Agent Phone on ${label}.`}</AppText>
    </View>
  ) : (
    <ComputerDisplay
      bar={{
        app,
        detail: phone ? null : machineName,
        menu: session ? [stopMenuItem(props.hostClient, label, phone, session)] : [],
        onTyping: props.onTyping,
        title: phone ? machineName : (app?.displayName ?? "This app"),
      }}
      interactive={phone}
      active={props.active}
      hostClient={props.hostClient}
      source={{
        kind: "task-session",
        sessionId: props.computerSessionId,
        ...(props.appKey === null ? {} : { appKey: props.appKey }),
      }}
      phone={phone}
      machineId={props.machineId}
      label={label}
    />
  );
}

function stopMenuItem(
  hostClient: HostClient,
  label: string,
  phone: boolean,
  session: Pick<ComputerUseSessionSummary, "runId" | "sessionId">,
): NativeMenuOption {
  return {
    destructive: true,
    icon: "stop.circle",
    id: "stop",
    label: `Stop using ${phone ? "phone" : label}`,
    onPress: () =>
      computerUseStops(hostClient).stop({
        machineName: label,
        sessionId: session.sessionId,
        runId: session.runId,
      }),
  };
}

/**
 * A phone's tab: the person's own view while that can show anything, else the
 * task holding the phone, else one Open. Nothing here opens by itself, so only
 * that press arms the phone's wake.
 */
export function PhoneTabView(props: {
  readonly active: boolean;
  readonly hostClient: HostClient;
  readonly machineId: string;
  readonly onClosed: () => void;
  readonly onTyping: (typing: boolean) => void;
}) {
  const { hostClient, machineId, onClosed } = props;
  const key = phonePlaceKey(machineId);
  const place = usePlaceList(hostClient).find((item) => item.key === key) ?? null;
  const closeTab = () => {
    hostClient.closePhoneTab(machineId).then(onClosed, (error: unknown) => {
      Alert.alert(
        "Couldn’t close this tab",
        error instanceof Error ? error.message : "Please try again.",
      );
    });
  };
  const closable = place?.phoneTab === true && place.closable;
  if (place?.ownerView)
    return (
      <ComputerOwnerView
        active={props.active}
        appKey={null}
        generation={place.ownerView.generation}
        hostClient={hostClient}
        key={`${place.ownerView.viewId}:${place.ownerView.generation}`}
        machineId={machineId}
        menu={[
          ...(place.task ? [stopMenuItem(hostClient, place.title, true, place.task)] : []),
          ...(closable
            ? [
                {
                  destructive: true,
                  icon: "xmark.circle" as const,
                  id: "close",
                  label: "Close tab",
                  onPress: closeTab,
                },
              ]
            : []),
        ]}
        onTyping={props.onTyping}
        viewId={place.ownerView.viewId}
      />
    );
  if (place?.task)
    return (
      <ComputerTaskView
        active={props.active}
        appKey={null}
        computerSessionId={place.task.sessionId}
        hostClient={hostClient}
        key={place.task.sessionId}
        machineId={machineId}
        onTyping={props.onTyping}
      />
    );
  return (
    <PhoneTabResting
      hostClient={hostClient}
      machineId={machineId}
      onClose={closable ? closeTab : null}
    />
  );
}

function PhoneTabResting(props: {
  readonly hostClient: HostClient;
  readonly machineId: string;
  readonly onClose: (() => void) | null;
}) {
  const { hostClient, machineId } = props;
  const navigation = useNavigation();
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const machine = useHostSelector(hostClient, (snapshot) =>
    snapshot.machines.find((value) => value.id === machineId),
  );
  const name = machine?.name ?? "Your phone";
  const computer = ownerViewComputerReadiness(machine, true);
  const open = async () => {
    setOpening(true);
    setFailure(null);
    try {
      await openPhoneOwnerView(
        hostClient,
        machineId,
        () => mounted.current && navigation.isFocused(),
      );
    } catch (error) {
      if (mounted.current)
        setFailure(error instanceof Error ? error.message : `${name} could not be opened.`);
    } finally {
      if (mounted.current) setOpening(false);
    }
  };
  return (
    <View style={styles.stage}>
      <View style={styles.status}>
        <AppText role="bodyMedium" style={styles.statusText}>
          {computer === null
            ? `Open ${name} to see it and use it.`
            : computerReasonWords(computer, { machine: name, phone: true, target: name })}
        </AppText>
        {computer === null ? (
          <SecondaryButton
            accessibilityLabel={`Open ${name}`}
            disabled={opening}
            label={opening ? "Opening…" : "Open"}
            onPress={() => void open()}
          />
        ) : null}
        {props.onClose ? <SecondaryButton label="Close tab" onPress={props.onClose} /> : null}
        {failure ? (
          <AppText role="secondary" style={styles.statusText} tone="muted">
            {failure}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

/** A view this close to its expiry when it comes into sight is renewed at once. */
const renewSoonMs = 90_000;

/** Thumbnails and full viewers keep the same exact owner generation alive. */
function useVisibleOwnerRetention(
  hostClient: HostClient,
  source: NativeViewerSource,
  active: boolean,
): void {
  const viewId = source.kind === "owner-view" ? source.viewId : null;
  const generation = source.kind === "owner-view" ? source.generation : null;
  const selectView = useCallback(
    (snapshot: HostSnapshot) =>
      viewId === null
        ? null
        : (snapshot.machines
            .flatMap((machine) => machine.computerUse?.ownerViews ?? [])
            .find((view) => view.viewId === viewId && view.generation === generation) ?? null),
    [generation, viewId],
  );
  const view = useHostSelector(hostClient, selectView);
  const ready = view?.state === "ready";
  const expiresAt = useRef<string | null>(null);
  expiresAt.current = view?.expiresAt ?? null;
  useEffect(() => {
    if (!active || !ready || viewId === null || generation === null) return;
    const held = hostClient.retainComputerView(viewId, generation);
    const expiry = expiresAt.current;
    if (expiry !== null && Date.parse(expiry) - Date.now() < renewSoonMs)
      void hostClient.renewComputerView(viewId, generation).catch(() => undefined);
    return () => held.release();
  }, [active, generation, hostClient, ready, viewId]);
}

/**
 * The person's own view of an app or phone — one they opened — by
 * its exact generation. It is kept alive only while it is in front of the
 * reader here, as the web keeps it. A closed or replaced view says so and
 * stays ended: a task holding the same app never stands in for it.
 */
export function ComputerOwnerView(props: {
  readonly active: boolean;
  readonly onTyping: (typing: boolean) => void;
  readonly appKey: string | null;
  readonly generation: number;
  readonly hostClient: HostClient;
  readonly machineId: string;
  readonly menu?: NativeMenuSection;
  readonly viewId: string;
  /** The Mac window the view bound, reopened as the same window. */
  readonly windowId?: number | undefined;
}) {
  const { active, generation, hostClient, viewId } = props;
  const navigation = useNavigation();
  const [reopening, setReopening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reopen = async () => {
    setReopening(true);
    setFailure(null);
    try {
      const deploymentId = hostClient.getSnapshot().deploymentId;
      const stillHere = () =>
        mounted.current &&
        navigation.isFocused() &&
        hostClient.getSnapshot().deploymentId === deploymentId;
      if (props.appKey === null) {
        await openPhoneOwnerView(hostClient, props.machineId, stillHere);
        return;
      }
      const destination = await openAppOwnerView(
        hostClient,
        props.machineId,
        props.appKey,
        props.windowId,
        stillHere,
      );
      if (destination && deploymentId)
        navigation.dispatch(
          StackActions.replace("WorkspaceBrowser", workspaceRoute(deploymentId, destination)),
        );
    } catch (error) {
      if (mounted.current)
        setFailure(error instanceof Error ? error.message : `${label} could not be opened.`);
    } finally {
      if (mounted.current) setReopening(false);
    }
  };
  const machine = useHostSelector(hostClient, (snapshot) =>
    snapshot.machines.find((value) => value.id === props.machineId),
  );
  const view = machine?.computerUse?.ownerViews?.find((value) => value.viewId === viewId);
  const current =
    view !== undefined && view.generation === generation && view.state !== "closed" ? view : null;
  const phone = props.appKey === null;
  const machineName = machine?.name ?? (phone ? "Your phone" : "Your Mac");
  const label = phone
    ? machineName
    : view?.target.kind === "app"
      ? view.target.app.displayName
      : "This app";
  if (current === null)
    return (
      <View style={styles.stage}>
        <View style={styles.status}>
          <AppText role="bodyMedium" style={styles.statusText}>
            This view has ended
          </AppText>
          <SecondaryButton
            accessibilityLabel={phone ? "Reopen phone" : `Reopen ${label}`}
            disabled={reopening}
            label={reopening ? "Opening…" : "Reopen"}
            onPress={() => void reopen()}
          />
          {failure ? (
            <AppText role="secondary" style={styles.statusText} tone="muted">
              {failure}
            </AppText>
          ) : null}
        </View>
      </View>
    );
  return (
    <ComputerDisplay
      bar={{
        app: current.target.kind === "app" ? current.target.app : undefined,
        detail: phone ? null : machineName,
        menu: props.menu ?? [],
        onTyping: props.onTyping,
        title: label,
      }}
      interactive
      active={active}
      hostClient={hostClient}
      label={label}
      machineId={props.machineId}
      phone={phone}
      onReopen={phone ? () => void reopen() : undefined}
      source={{ generation, kind: "owner-view", viewId }}
    />
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    paddingHorizontal: space[12],
    paddingVertical: space[6],
    position: "absolute",
    right: space[12],
    top: space[12],
  },
  key: { alignItems: "center", height: 44, justifyContent: "center", width: 42 },
  keys: { alignItems: "center", flexDirection: "row", paddingHorizontal: space[2] },
  name: { flex: 1, gap: space[10], minWidth: 0, paddingHorizontal: space[14] },
  nameWords: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.6 },
  stage: {
    backgroundColor: color.background,
    borderRadius: radius.xs,
    flex: 1,
    overflow: "hidden",
  },
  status: {
    alignItems: "center",
    backgroundColor: color.background,
    bottom: 0,
    gap: space[12],
    justifyContent: "center",
    left: 0,
    padding: space[24],
    position: "absolute",
    right: 0,
    top: 0,
  },
  statusText: { textAlign: "center" },
  viewer: { flex: 1 },
});
