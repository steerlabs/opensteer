import { browserAddressParts } from "@opensteer/client/host";
import { memo, useLayoutEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import {
  StackActions,
  useNavigation,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import type { BrowserTabOpenHandle, BrowserTabOpenInput, HostClient } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { isRecord } from "@opensteer/shared/isRecord";
import { space } from "../theme.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import type { SurfacesRoute } from "./surface-route.js";
import { Toolbar, ToolbarCapsule, ToolbarMenu } from "./toolbar.js";

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
  const parts = browserAddressParts(pending?.url ?? "");
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
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => null,
      headerTitle: undefined,
      title: "New tab",
      unstable_headerRightItems: () => [],
    });
  }, [navigation]);
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
    <View style={styles.fill}>
      <View accessibilityLiveRegion="polite" style={styles.status}>
        {pending?.state === "opening" ? (
          <ActivityIndicator accessibilityLabel="Opening tab" />
        ) : null}
        <AppText accessibilityLabel={pending?.url ?? "New tab"} numberOfLines={1} role="bodyMedium">
          {parts?.host ?? "New tab"}
          <AppText role="bodyMedium" tone="muted">
            {parts?.rest ?? ""}
          </AppText>
        </AppText>
        {pending?.state === "opening" ? (
          <AppText role="secondary" tone="muted">
            {title}
          </AppText>
        ) : (
          <Notice
            title={title}
            detail={
              pending?.state === "unknown"
                ? "The Host may have opened this tab. Retry to recover the same opening."
                : (pending?.error?.message ?? "")
            }
          />
        )}
        {pending && pending.state !== "opening" ? (
          <SecondaryButton label="Retry" onPress={() => retry()} />
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
      </View>
      <Toolbar edge="bottom" testID="page-toolbar">
        <ToolbarCapsule style={styles.address}>
          <AppText numberOfLines={1} role="secondaryMedium" tone="muted">
            {parts?.host ?? "New tab"}
          </AppText>
        </ToolbarCapsule>
        <ToolbarMenu
          label="More"
          sections={[
            [
              {
                destructive: true,
                icon: "xmark.circle",
                id: "close",
                label: "Close tab",
                onPress: close,
              },
            ],
          ]}
          symbol="ellipsis"
        />
      </Toolbar>
    </View>
  );
});

const styles = StyleSheet.create({
  address: { flex: 1, justifyContent: "center", minWidth: 0, paddingHorizontal: space[16] },
  fill: { flex: 1 },
  status: {
    alignItems: "center",
    flex: 1,
    gap: space[12],
    justifyContent: "center",
    padding: space[24],
  },
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
