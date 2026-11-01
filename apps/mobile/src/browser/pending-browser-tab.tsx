import { memo } from "react";
import { ActivityIndicator, View } from "react-native";
import {
  StackActions,
  useNavigation,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import type { BrowserTabOpenHandle, BrowserTabOpenInput, HostClient } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { isRecord } from "@opensteer/shared/isRecord";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { useSurfaceHeader } from "./surface-header.js";
import type { SurfacesRoute } from "./surface-route.js";

export function showPendingBrowserTab(
  navigation: Pick<NavigationProp<ParamListBase>, "dispatch"> & {
    readonly getState: () => ReturnType<NavigationProp<ParamListBase>["getState"]> | undefined;
  },
  route: SurfacesRoute,
  opening: BrowserTabOpenHandle,
): void {
  const scope =
    route.scope === "workspace" ? { scope: "workspace" as const } : { threadId: route.threadId };
  navigation.dispatch(
    StackActions.replace("WorkspaceBrowser", {
      deploymentId: route.deploymentId,
      ...scope,
      pendingBrowserTab: opening.idempotencyKey,
    }),
  );
  void opening.result.then(
    (opened) => {
      const state = navigation.getState();
      const current = state?.routes[state.index];
      if (
        current?.name !== "WorkspaceBrowser" ||
        !isRecord(current.params) ||
        current.params["pendingBrowserTab"] !== opening.idempotencyKey ||
        current.params["deploymentId"] !== route.deploymentId
      )
        return;
      navigation.dispatch({
        ...StackActions.replace("WorkspaceBrowser", {
          deploymentId: route.deploymentId,
          ...(current.params["scope"] === "workspace"
            ? { scope: "workspace" }
            : { threadId: current.params["threadId"] }),
          sessionId: opened.sessionId,
          tabId: opened.tabId,
          editAddress: true,
        }),
        ...(current.key ? { source: current.key } : {}),
      });
    },
    () => undefined,
  );
}

export const PendingBrowserTabView = memo(function PendingBrowserTabView({
  hostClient,
  route,
}: {
  readonly hostClient: HostClient;
  readonly route: SurfacesRoute;
}) {
  const navigation = useNavigation();
  const pending = useHostSelector(hostClient, (snapshot) =>
    snapshot.pendingBrowserTabs?.find((row) => row.idempotencyKey === route.pendingBrowserTab),
  );
  const placements = useHostSelector(hostClient, (snapshot) => snapshot.browserPlacements);
  const close = () => {
    if (route.pendingBrowserTab) hostClient.dismissPendingBrowserTab(route.pendingBrowserTab);
    navigation.goBack();
  };
  const title =
    pending?.state === "unknown"
      ? "Opening status unknown"
      : pending?.state === "failed"
        ? pending.error?.code === "browser-placement-ambiguous"
          ? "Which computer should this tab open on?"
          : "Couldn’t open this tab"
        : pending
          ? "Opening…"
          : "This opening is no longer available";
  useSurfaceHeader({
    acting: false,
    secondary: pending?.url ?? null,
    glyph: "globe",
    title,
    menu: [{ id: "close", icon: "xmark", label: "Close tab", onPress: close }],
  });
  const retry = (target?: BrowserTabOpenInput) => {
    if (!pending || pending.state === "opening") return;
    const opening = hostClient.beginBrowserTabOpen(target ?? pending.target, {
      ...(pending.url === undefined ? {} : { url: pending.url }),
      ...(pending.typed === undefined ? {} : { typed: pending.typed }),
      ...(pending.viewport ? { viewport: pending.viewport } : {}),
      ...(pending.state === "unknown" ? { idempotencyKey: pending.idempotencyKey } : {}),
    });
    if (opening.idempotencyKey !== pending.idempotencyKey)
      hostClient.dismissPendingBrowserTab(pending.idempotencyKey);
    showPendingBrowserTab(navigation, route, opening);
  };
  return (
    <Screen>
      <View>
        <AppText>{pending?.url ?? "New tab"}</AppText>
        {pending?.state === "opening" ? (
          <ActivityIndicator accessibilityLabel="Opening tab" />
        ) : null}
        <Notice
          title={title}
          detail={
            pending?.state === "unknown"
              ? "The Host may have opened this tab. Check again to recover the same opening."
              : (pending?.error?.message ?? "")
          }
        />
        {pending && pending.state !== "opening" ? (
          <SecondaryButton
            label={pending.state === "unknown" ? "Check again" : "Retry"}
            onPress={() => retry()}
          />
        ) : null}
        {pending?.state === "failed" &&
        pending.error?.code === "browser-placement-ambiguous" &&
        "identity" in pending.target
          ? placements
              .filter((placement) => placement.available)
              .map((placement) => (
                <SecondaryButton
                  key={placement.runnerId}
                  label={`Open on ${placement.label}`}
                  onPress={() => {
                    if ("identity" in pending.target)
                      retry({
                        ...pending.target,
                        placement: { kind: "runner", runnerId: placement.runnerId },
                      });
                  }}
                />
              ))
          : null}
        <SecondaryButton label="Close tab" onPress={close} />
      </View>
    </Screen>
  );
});

export const PendingBrowserTabRows = memo(function PendingBrowserTabRows({
  hostClient,
  deploymentId,
}: {
  readonly hostClient: HostClient;
  readonly deploymentId: string;
}) {
  const navigation = useNavigation();
  const rows = useHostSelector(hostClient, (snapshot) => snapshot.pendingBrowserTabs);
  return rows?.map((pending) => (
    <SecondaryButton
      key={pending.idempotencyKey}
      label={pending.url ?? "Opening new tab…"}
      onPress={() =>
        navigation.dispatch(
          StackActions.push("WorkspaceBrowser", {
            deploymentId,
            scope: "workspace",
            pendingBrowserTab: pending.idempotencyKey,
          }),
        )
      }
    />
  ));
});
