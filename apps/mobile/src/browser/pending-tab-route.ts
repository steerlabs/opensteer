import type { BrowserTabOpenHandle } from "@opensteer/client/host";
import { isRecord } from "@opensteer/shared/isRecord";
import { StackActions, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import type { SurfacesRoute } from "./surface-route.js";

export function showPendingBrowserTab(
  navigation: Pick<NavigationProp<ParamListBase>, "dispatch"> & {
    readonly getState: () => ReturnType<NavigationProp<ParamListBase>["getState"]> | undefined;
  },
  route: SurfacesRoute,
  opening: BrowserTabOpenHandle,
  /**
   * Opened over the screen it came from rather than in its place. A link
   * already says where it goes, so its address isn't offered for editing, and
   * should it not open, `fallback` takes it the way links went before: the tap
   * is never lost.
   */
  over?: { readonly fallback?: () => void },
): void {
  const scope = route.scope === "tabs" ? { scope: "tabs" as const } : { threadId: route.threadId };
  const show = over ? StackActions.push : StackActions.replace;
  const fallback = over?.fallback;
  navigation.dispatch(
    show("WorkspaceBrowser", {
      deploymentId: route.deploymentId,
      ...scope,
      pendingBrowserTab: opening.idempotencyKey,
    }),
  );
  const stillShown = () => {
    const state = navigation.getState();
    const current = state?.routes[state.index];
    return current?.name === "WorkspaceBrowser" &&
      isRecord(current.params) &&
      current.params["pendingBrowserTab"] === opening.idempotencyKey &&
      current.params["deploymentId"] === route.deploymentId
      ? { key: current.key, params: current.params }
      : null;
  };
  void opening.result.then(
    (opened) => {
      const current = stillShown();
      if (current === null) return;
      navigation.dispatch({
        ...StackActions.replace("WorkspaceBrowser", {
          deploymentId: route.deploymentId,
          ...(current.params["scope"] === "tabs"
            ? { scope: "tabs" }
            : { threadId: current.params["threadId"] }),
          sessionId: opened.sessionId,
          tabId: opened.tabId,
          editAddress: fallback === undefined,
        }),
        ...(current.key ? { source: current.key } : {}),
      });
    },
    () => {
      if (fallback === undefined || stillShown() === null) return;
      navigation.dispatch(StackActions.pop());
      fallback();
    },
  );
}
