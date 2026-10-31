import { placeList, threadInDirectory, type HostClient } from "@opensteer/client/host";
import {
  listedScreenSurface,
  preparedPresentation,
  type ScreenPresentationPort,
  type ScreenPresentationReceipt,
  type ScreenShowTarget,
} from "@opensteer/client/screen";
import type { VoiceTarget } from "@opensteer/client/voice";
import { isRecord } from "@opensteer/shared/isRecord";
import { StackActions, type NavigationAction } from "@react-navigation/native";
import {
  paramsDestination,
  routeDestination,
  sameDestination,
  surfaceRoute,
  workspaceRoute,
  type SurfacesRoute,
} from "../browser/surface-route.js";
import { heardPlaces } from "./places.js";

interface Route {
  readonly key?: string;
  readonly name: string;
  readonly params?: object | undefined;
}
interface State {
  readonly key?: string;
  readonly index?: number;
  readonly routes: readonly (Route & { readonly state?: State | undefined })[];
}

/** The part of the navigation container this needs; the app passes `navigationRef`. */
export interface PresentationNavigator {
  isReady(): boolean;
  getRootState(): State | undefined;
  getCurrentRoute(): Route | undefined;
  getCurrentOptions(): object | undefined;
  canGoBack(): boolean;
  goBack(): void;
  dispatch(action: NavigationAction): void;
  addListener(type: "state", listener: () => void): () => void;
}

/** What the phone itself says about the person: in front, typing, in the drawer, able to play Mac video. */
export interface PresentationDevice {
  active(): boolean;
  editing(): boolean;
  /** The drawer lies over the screen; navigating under it would close it. */
  covered(): boolean;
  readonly macVideo: boolean;
  /** The keyboard rising or the app leaving the foreground. */
  observe(listener: () => void): () => void;
}

type Destination =
  | { readonly name: "Home"; readonly params: { readonly deploymentId: string } }
  | {
      readonly name: "Thread";
      readonly params: { readonly deploymentId: string; readonly threadId: string };
    }
  | { readonly name: "WorkspaceBrowser"; readonly params: SurfacesRoute };

const busy: ScreenPresentationReceipt = { outcome: "superseded", reason: "busy" };
const closed: ScreenPresentationReceipt = { outcome: "unavailable", reason: "closed" };
const applied: ScreenPresentationReceipt = { outcome: "applied" };
const unconfirmed: ScreenPresentationReceipt = { outcome: "unconfirmed" };

/** Which screens are in front, by route identity; a changed parameter is not a new screen. */
function signature(state: State | undefined): string {
  if (!state) return "";
  const route = state.routes[state.index ?? state.routes.length - 1];
  return `${state.key ?? ""}:${route?.key ?? ""}${route?.state ? `/${signature(route.state)}` : ""}`;
}

function shows(route: Route | undefined, destination: Destination): boolean {
  if (route?.name !== destination.name || !isRecord(route.params)) return false;
  const params = route.params;
  if (params["deploymentId"] !== destination.params.deploymentId) return false;
  switch (destination.name) {
    case "Home":
      return true;
    case "Thread":
      return params["threadId"] === destination.params.threadId;
    case "WorkspaceBrowser":
      return (
        params["scope"] === destination.params.scope &&
        params["threadId"] === destination.params.threadId &&
        sameDestination(paramsDestination(params), routeDestination(destination.params))
      );
  }
}

/**
 * Showing something from the voice call on a phone, as an agent asked or as
 * the person said: exactly one stack transition, and none when it is already
 * in front. A conversation, a tab alone, or a tab over a conversation's sheet
 * is one pushed screen, so Back returns to what was there before. Chat is the
 * stack's root, and the one screen it has: showing it returns there, as the
 * person's own Chat choice does, and leaves nothing above it for Back. A
 * second Chat over the stack would let a draft drift between two copies, and
 * the sidebar and the Deployment both read the root. Every navigation the
 * presentation did not make, the keyboard rising, a press into a live page or
 * display, the drawer opening and the app leaving the foreground count as the
 * person's own, so nothing captured before them can land after.
 */
export function mobileScreenPresentation(input: {
  readonly navigator: PresentationNavigator;
  readonly device: PresentationDevice;
  readonly hostClient: HostClient;
  readonly deploymentId: () => string | null;
}): {
  readonly port: ScreenPresentationPort;
  /** The person's own spoken navigation, through the same transitions. */
  readonly show: (target: VoiceTarget) => void;
  readonly dispose: () => void;
} {
  const { navigator, device, hostClient } = input;
  let revision = 0;
  let seen = signature(navigator.getRootState());
  let arriving: {
    readonly destination: Destination;
    readonly settle: (receipt: ScreenPresentationReceipt) => void;
  } | null = null;
  const observe = () => {
    const now = signature(navigator.getRootState());
    if (now === seen) return;
    seen = now;
    const pending = arriving;
    arriving = null;
    if (pending && shows(navigator.getCurrentRoute(), pending.destination)) {
      pending.settle(applied);
      return;
    }
    pending?.settle(unconfirmed);
    revision += 1;
  };
  const stopNavigation = navigator.addListener("state", observe);
  const stopDevice = device.observe(() => {
    revision += 1;
  });

  const blocked = (): ScreenPresentationReceipt | null => {
    observe();
    if (!device.active() || device.editing() || device.covered()) return busy;
    const root = navigator.getRootState();
    // A nested navigator in front is a flow presented over the app, such as adding a deployment.
    if (root?.routes[root.index ?? 0]?.state) return busy;
    const presentation = (navigator.getCurrentOptions() as { presentation?: unknown } | undefined)
      ?.presentation;
    return presentation === undefined || presentation === "card" ? null : busy;
  };

  const resolve = (
    target: ScreenShowTarget,
  ): { readonly destination: Destination } | { readonly receipt: ScreenPresentationReceipt } => {
    const deploymentId = input.deploymentId();
    if (deploymentId === null || !navigator.isReady()) return { receipt: closed };
    const snapshot = hostClient.getSnapshot();
    const { conversationId, surface } = target;
    const home = conversationId !== undefined && conversationId === snapshot.homeThreadId;
    if (conversationId !== undefined && !home && !threadInDirectory(conversationId, snapshot))
      return { receipt: closed };
    if (surface) {
      const place = listedScreenSurface(placeList(snapshot), surface);
      if (!place) return { receipt: closed };
      // A Mac window's video does not play on iOS; a phone's display does.
      if (place.destination.kind === "app" && !device.macVideo)
        return { receipt: { outcome: "unsupported" } };
      return {
        destination: {
          name: "WorkspaceBrowser",
          params:
            conversationId === undefined
              ? workspaceRoute(deploymentId, place.destination)
              : surfaceRoute(deploymentId, conversationId, place.destination),
        },
      };
    }
    return {
      destination: home
        ? { name: "Home", params: { deploymentId } }
        : { name: "Thread", params: { deploymentId, threadId: conversationId! } },
    };
  };

  const transition = (destination: Destination): NavigationAction =>
    destination.name === "Home"
      ? StackActions.popTo("Home", destination.params)
      : StackActions.push(destination.name, destination.params);

  const port: ScreenPresentationPort = {
    capture() {
      observe();
      const route = navigator.getCurrentRoute();
      const threadId =
        (route?.name === "Thread" || route?.name === "WorkspaceBrowser") && isRecord(route.params)
          ? route.params["threadId"]
          : undefined;
      return {
        interactionRevision: revision,
        ...(typeof threadId === "string" && threadId !== hostClient.getSnapshot().homeThreadId
          ? { currentThreadId: threadId }
          : {}),
        places: heardPlaces(hostClient, route),
      };
    },
    blocked,
    async prepare(target, signal) {
      signal.throwIfAborted();
      let destination: Destination | null = null;
      return preparedPresentation({
        signal,
        refusal: () => {
          const refused = blocked();
          if (refused) return refused;
          const resolved = resolve(target);
          if ("receipt" in resolved) return resolved.receipt;
          destination = resolved.destination;
          return null;
        },
        commit: (lifetime) => {
          const chosen = destination!;
          if (shows(navigator.getCurrentRoute(), chosen)) return Promise.resolve(applied);
          return new Promise((settle) => {
            const pending = { destination: chosen, settle };
            arriving?.settle(unconfirmed);
            arriving = pending;
            lifetime.addEventListener("abort", () => {
              if (arriving === pending) arriving = null;
              settle(unconfirmed);
            });
            navigator.dispatch(transition(chosen));
            // A container that applied the action at once has already moved.
            observe();
          });
        },
      });
    },
  };

  return {
    port,
    show(target) {
      revision += 1;
      const deploymentId = input.deploymentId();
      if (deploymentId === null || !navigator.isReady()) return;
      if (target.kind === "back") {
        if (navigator.canGoBack()) navigator.goBack();
        return;
      }
      const destination: Destination =
        target.kind === "chat"
          ? { name: "Home", params: { deploymentId } }
          : target.kind === "thread"
            ? { name: "Thread", params: { deploymentId, threadId: target.threadId } }
            : {
                name: "WorkspaceBrowser",
                params: workspaceRoute(deploymentId, target.destination),
              };
      if (!shows(navigator.getCurrentRoute(), destination))
        navigator.dispatch(transition(destination));
    },
    dispose() {
      stopNavigation();
      stopDevice();
      arriving?.settle(unconfirmed);
      arriving = null;
    },
  };
}
