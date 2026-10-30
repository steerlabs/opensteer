import type { HostClient, HostSnapshot, NativeViewerSource } from "@opensteer/client/host";
import {
  computerUseStops,
  computerReasonWords,
  computerDisplayScope,
  computerDisplayStatus,
  sharedDisplayStreams,
  type DisplayFrame,
  type DisplayLease,
} from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { requireNativeView } from "expo";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  ActivityIndicator,
  AppState,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ViewProps,
} from "react-native";
import { useSurfaceHeader } from "../browser/surface-header.js";
import { color } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import {
  DisplayControls,
  type DisplayPicture,
  type DisplayControlsHandle,
} from "./display-input.js";

interface Decoder {
  reset(epoch: string): Promise<void>;
  decode(frame: {
    epoch: string;
    data: string;
    width: number;
    height: number;
    pts: number;
    key: boolean;
    replayed: boolean;
  }): Promise<boolean>;
}
const NativeDisplay = requireNativeView<
  ViewProps & {
    ref?: Ref<Decoder>;
    onReady?: (event: { nativeEvent: { epoch: string; width: number; height: number } }) => void;
    onNeedsKeyframe?: (event: { nativeEvent: { epoch: string } }) => void;
  }
>("PhoneDisplay");

/** A native surface consumes the shared transport's exact task authority; it never asks for a screenshot. */
export function ComputerDisplay({
  active,
  hostClient,
  source: reference,
  phone,
  label,
  machineId,
  onPageSize,
  interactive = false,
}: {
  readonly active: boolean;
  readonly interactive?: boolean;
  readonly hostClient: HostClient;
  readonly source: NativeViewerSource;
  readonly phone: boolean;
  readonly label: string;
  readonly machineId?: string;
  readonly onPageSize?: ((size: { width: number; height: number }) => void) | undefined;
}) {
  const unavailable = !phone && Platform.OS === "ios";
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
  const [inputLease, setInputLease] = useState<DisplayLease | null>(null);
  const [picture, setPicture] = useState<DisplayPicture | null>(null);
  const decodingPicture = useRef<DisplayPicture | null>(null);
  const decoder = useRef<Decoder | null>(null);
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
  const resetDecoder = useCallback((next: number) => {
    const native = decoder.current;
    if (!native) return;
    void native.reset(String(next)).catch(() => {
      // Native teardown already clears its surface. A bridge call queued before
      // removal can reject after that view's tag is gone.
      if (!mounted.current || decoder.current !== native) return;
      setShown(false);
      setWords("Video sharing is unavailable");
    });
  }, []);
  const selectScope = useCallback(
    (snapshot: HostSnapshot) => computerDisplayScope(snapshot, source),
    [source],
  );
  const scope = useHostSelector(hostClient, selectScope);
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
    if (unavailable || !active || !foreground || !scope) {
      setShown(false);
      resetDecoder(++epoch.current);
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
    let tail = Promise.resolve();
    let bytes = 0;
    const pending = new Set<DisplayFrame>();
    const clear = () => {
      epoch.current++;
      setPicture(null);
      decodingPicture.current = null;
      generation = -1;
      setShown(false);
      resetDecoder(epoch.current);
      for (const frame of pending) frame.done();
      pending.clear();
      bytes = 0;
    };
    const changed = () => {
      const snapshot = lease.getSnapshot();
      const status = computerDisplayStatus(snapshot, phone);
      setWords(
        status.reason
          ? computerReasonWords(status.reason, { machine: label, target: label, phone })
          : null,
      );
      setTerminal(snapshot.connection === "closed");
      if (
        snapshot.connection === "closed" ||
        snapshot.connection === "connecting" ||
        (snapshot.display && !["starting", "live"].includes(snapshot.display.state))
      )
        clear();
    };
    const unsubscribe = lease.subscribe(changed);
    const invalidate = hostClient.subscribe(() => {
      if (computerDisplayScope(hostClient.getSnapshot(), source) === scope) return;
      clear();
      pool.invalidate(
        (target) => computerDisplayScope(hostClient.getSnapshot(), target.source) === target.scope,
      );
    });
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
        clear();
        connection = frame.connection;
        generation = frame.header.generation;
      }
      if (
        pending.size >= (frame.replayed ? 600 : 4) ||
        (pending.size > 0 && bytes + frame.payload.byteLength > 1_048_576)
      ) {
        frame.done();
        lease.requestKeyframe();
        return;
      }
      pending.add(frame);
      bytes += frame.payload.byteLength;
      const current = epoch.current;
      tail = tail
        .then(async () => {
          if (disposed || current !== epoch.current) return;
          const native = decoder.current;
          if (!native) {
            lease.requestKeyframe();
            return;
          }
          const raw = encodeBase64Url(frame.payload).replace(/-/g, "+").replace(/_/g, "/");
          const base64 = raw + "=".repeat((4 - (raw.length % 4)) % 4);
          const { width, height, ptsUs, key } = frame.header;
          decodingPicture.current = { generation: frame.header.generation, width, height };
          const accepted = await native.decode({
            epoch: String(current),
            data: base64,
            width,
            height,
            pts: ptsUs,
            key,
            replayed: frame.replayed,
          });
          if (!accepted && current === epoch.current) lease.requestKeyframe();
        })
        .catch(() => {
          if (!disposed) lease.requestKeyframe();
        })
        .finally(() => {
          if (pending.delete(frame)) bytes -= frame.payload.byteLength;
          frame.done();
        });
    });
    viewportChanged.current = phone ? null : (size) => lease.viewport(size);
    if (!phone) lease.viewport(viewport.current);
    changed();
    return () => {
      controls.current?.resetInput();
      setInputLease(null);
      viewportChanged.current = null;
      disposed = true;
      requestKeyframe.current = null;
      frames();
      unsubscribe();
      invalidate();
      clear();
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
  ]);
  return (
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
          picture={picture}
          phone={phone}
          visible={active && foreground && shown && !words}
        />
      ) : null}
      {unavailable || !shown || words || updateName !== null ? (
        <View style={styles.status}>
          {!unavailable && !words && updateName === null ? (
            <ActivityIndicator color={color.muted} />
          ) : null}
          <AppText tone="soft">
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
          {terminal && !phone && !unavailable ? (
            <Pressable accessibilityRole="button" onPress={() => reopen.current?.()}>
              <AppText>Open again</AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
export function ComputerTaskView(props: {
  readonly appKey: string | null;
  readonly active: boolean;
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
  useSurfaceHeader({
    title: label,
    secondary: phone ? null : machineName,
    acting: phone
      ? session?.actingDisplay === true
      : session?.actingAppKeys?.includes(props.appKey ?? "") === true,
    glyph: phone ? "smartphone" : "laptopcomputer",
    menu: session
      ? [
          {
            destructive: true,
            icon: "stop.circle",
            id: "stop",
            label: `Stop using ${phone ? "phone" : label}`,
            onPress: () =>
              computerUseStops(props.hostClient).stop({
                machineName: label,
                sessionId: session.sessionId,
                runId: session.runId,
              }),
          },
        ]
      : [],
  });
  return machine &&
    (machine.status === "needs-update" ||
      machine.status === "updating" ||
      machine.status === "update-pending") ? (
    <View style={styles.stage}>
      <AppText>{machine.detail ?? `Update Agent Phone on ${label}.`}</AppText>
    </View>
  ) : (
    <ComputerDisplay
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
 * The person's own view of an app or phone — one they opened on the Mac — by
 * its exact generation. It is kept alive only while it is in front of the
 * reader here, as the web keeps it. A closed or replaced view says so and
 * stays ended: a task holding the same app never stands in for it.
 */
export function ComputerOwnerView(props: {
  readonly active: boolean;
  readonly appKey: string | null;
  readonly generation: number;
  readonly hostClient: HostClient;
  readonly machineId: string;
  readonly viewId: string;
}) {
  const { active, generation, hostClient, viewId } = props;
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
    : current?.target.kind === "app"
      ? current.target.app.displayName
      : "This app";
  useSurfaceHeader({
    acting: false,
    glyph: phone ? "smartphone" : "laptopcomputer",
    menu: [],
    secondary: phone ? null : machineName,
    title: label,
  });
  if (current === null)
    return (
      <View style={styles.stage}>
        <View style={styles.status}>
          <AppText tone="soft">This view has ended</AppText>
          <AppText tone="muted">Open it again on the computer to see it here.</AppText>
        </View>
      </View>
    );
  return (
    <ComputerDisplay
      interactive={!phone}
      active={active}
      hostClient={hostClient}
      label={label}
      machineId={props.machineId}
      phone={phone}
      source={{ generation, kind: "owner-view", viewId }}
    />
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: "black" },
  status: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: "black",
  },
});
