import { useMemo } from "react";
import {
  RemoteAccessPortError,
  linkPersonalHostAccount,
  resumePersonalHostAccountLink,
  type HostClient,
  type RemoteAccessLink,
  type RemoteAccessPort,
} from "@opensteer/client/host";
import {
  useRemoteAccess,
  type RemoteAccessController,
  type usePersonalRemoteAccess,
} from "@opensteer/client/react";
import type { PersonalRemoteAdministrationStatus } from "@opensteer/protocol";
import type { DeploymentAccessSnapshot, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { useShell } from "../components/app-shell.js";
import { deploymentNameFrom } from "../components/deployment-name.js";
import { linkAccountThroughPortal } from "../components/settings/link-personal-account.js";
import {
  supportsPersonalAccountLink,
  usePersonalAccountLink,
  type PersonalAccountLinkController,
  type PersonalAccountLinkOutcome,
} from "./use-personal-account-link.js";

/** Outcomes that leave nothing for the next step to build on. */
function refuseUnfinished(outcome: PersonalAccountLinkOutcome): void {
  if (
    outcome.kind === "linked-elsewhere" ||
    outcome.kind === "needs-repair" ||
    outcome.kind === "unavailable"
  )
    throw new RemoteAccessPortError(outcome.message);
}

type DesktopSignInBridge = Pick<
  OpensteerDesktopBridge,
  "cancel" | "getDeploymentAccessSnapshot" | "onDeploymentAccessSnapshotChanged" | "signIn"
>;

/**
 * The computer's own app: it signs in through the browser first, because
 * linking needs an Account session, and finishes an activating link itself.
 */
export function desktopRemoteAccessPort(
  link: PersonalAccountLinkController,
  bridge: DesktopSignInBridge,
): RemoteAccessPort {
  return {
    signIn: (signal) => signInThroughBrowser(bridge, signal),
    link: async () => refuseUnfinished(await link.link()),
    repair: async () => {
      const outcome = await link.repair();
      if (!outcome.succeeded) throw new RemoteAccessPortError(outcome.message);
    },
  };
}

/**
 * Opens the Account sign-in in the browser and settles when it ends: signed
 * in, or given up. A browser tab closed mid sign-in sends nothing back, so a
 * sign-in still open from before is replaced by a fresh one, and stopping
 * the wait ends the one it opened.
 */
export async function signInThroughBrowser(
  bridge: DesktopSignInBridge,
  signal: AbortSignal,
): Promise<void> {
  const { account } = await bridge.getDeploymentAccessSnapshot();
  signal.throwIfAborted();
  if (account.status === "signed-in") return;
  if (account.status === "authorizing") await bridge.cancel();
  await bridge.signIn();
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      signal.removeEventListener("abort", aborted);
      settle();
    };
    const aborted = () => {
      finish(() => reject(signal.reason));
      void bridge
        .getDeploymentAccessSnapshot()
        .then(({ account: now }) => (now.status === "authorizing" ? bridge.cancel() : undefined))
        .catch(() => undefined);
    };
    const evaluate = ({ account: next }: DeploymentAccessSnapshot) => {
      if (next.status === "signed-in") finish(resolve);
      else if (next.status !== "authorizing")
        finish(() => reject(new RemoteAccessPortError("Sign-in didn’t finish. Try again.")));
    };
    signal.addEventListener("abort", aborted, { once: true });
    unsubscribe = bridge.onDeploymentAccessSnapshotChanged(evaluate);
    if (settled) unsubscribe();
    void bridge.getDeploymentAccessSnapshot().then(evaluate, () => undefined);
  });
}

/** A plain browser: the Account portal signs in and links in a popup. */
export function browserRemoteAccessPort(input: {
  readonly hostClient: HostClient;
  readonly name: string;
  readonly portalOrigin: string | null;
  readonly status: PersonalRemoteAdministrationStatus | null;
}): RemoteAccessPort {
  return {
    link: async ({ activating, signal }) => {
      if (activating) {
        await resumePersonalHostAccountLink(input.hostClient);
        return;
      }
      if (!input.status) throw new RemoteAccessPortError("Still checking. Try again in a moment.");
      await linkAccountThroughPortal({
        authorityEnvelope: input.status.authorityEnvelope,
        hostClient: input.hostClient,
        name: input.name,
        portalOrigin: input.portalOrigin,
        signal,
      });
    },
  };
}

type CourierBridge = Pick<OpensteerDesktopBridge, "signIn"> &
  Required<
    Pick<
      OpensteerDesktopBridge,
      "completePersonalAccountLink" | "issuePersonalAccountLinkChallenge"
    >
  >;

/**
 * The app viewing another computer: its own Account carries the link
 * credentials, and the viewed computer's Host approves and completes the link.
 * The app's own computer is never touched.
 */
export function courierRemoteAccessPort(input: {
  readonly bridge: CourierBridge;
  readonly hostClient: HostClient;
  readonly name: string;
  readonly status: PersonalRemoteAdministrationStatus | null;
}): RemoteAccessPort {
  const { bridge } = input;
  return {
    signIn: () => bridge.signIn(),
    link: async ({ activating }) => {
      if (activating) {
        await resumePersonalHostAccountLink(input.hostClient);
        return;
      }
      if (!input.status) throw new RemoteAccessPortError("Still checking. Try again in a moment.");
      await linkPersonalHostAccount(
        input.hostClient,
        {
          issuePersonalHostAccountLinkChallenge: (request) =>
            bridge.issuePersonalAccountLinkChallenge(request),
          completePersonalHostAccountLink: (_challengeId, request) =>
            bridge.completePersonalAccountLink(request),
        },
        input.status.authorityEnvelope,
        input.name,
      );
    },
  };
}

/**
 * Which half links the viewed computer. The desktop's own journal and link
 * status describe only the desktop's own personal deployment.
 */
export function webRemoteAccessRoute(input: {
  readonly bridge: OpensteerDesktopBridge | null;
  readonly deploymentAccess: DeploymentAccessSnapshot | null;
  readonly viewedDeploymentId: string | null;
}):
  | { readonly kind: "desktop"; readonly bridge: OpensteerDesktopBridge }
  | { readonly kind: "courier"; readonly bridge: CourierBridge }
  | { readonly kind: "browser" } {
  const { bridge, deploymentAccess, viewedDeploymentId } = input;
  if (!bridge) return { kind: "browser" };
  const own =
    viewedDeploymentId !== null &&
    deploymentAccess?.personalSetup?.deploymentId === viewedDeploymentId;
  if (own && supportsPersonalAccountLink(bridge)) return { kind: "desktop", bridge };
  const { completePersonalAccountLink, issuePersonalAccountLinkChallenge } = bridge;
  if (!own && completePersonalAccountLink && issuePersonalAccountLinkChallenge)
    return {
      kind: "courier",
      bridge: {
        completePersonalAccountLink: completePersonalAccountLink.bind(bridge),
        issuePersonalAccountLinkChallenge: issuePersonalAccountLinkChallenge.bind(bridge),
        signIn: bridge.signIn.bind(bridge),
      },
    };
  return { kind: "browser" };
}

/** "Use from anywhere" for the computer this web or desktop window is attached to. */
export function useWebRemoteAccess(
  remote: ReturnType<typeof usePersonalRemoteAccess>,
): RemoteAccessController {
  const { deploymentAccess, desktopBridge, desktopDeployment, hostClient, snapshot } = useShell();
  const route = useMemo(
    () =>
      webRemoteAccessRoute({
        bridge: desktopBridge,
        deploymentAccess,
        viewedDeploymentId: snapshot.deploymentId,
      }),
    [deploymentAccess, desktopBridge, snapshot.deploymentId],
  );
  const link = usePersonalAccountLink(
    route.kind === "desktop" ? route.bridge : null,
    deploymentAccess,
  );
  const name = deploymentNameFrom(desktopDeployment, snapshot);
  const portalOrigin = snapshot.identityConfig?.portalOrigin ?? null;
  const port = useMemo(() => {
    if (route.kind === "desktop") return desktopRemoteAccessPort(link, route.bridge);
    const common = { hostClient, name: name ?? "Opensteer", status: remote.status };
    return route.kind === "courier"
      ? courierRemoteAccessPort({ ...common, bridge: route.bridge })
      : browserRemoteAccessPort({ ...common, portalOrigin });
  }, [hostClient, link, name, portalOrigin, remote.status, route]);
  const linkStatus: RemoteAccessLink | null =
    route.kind === "desktop" ? (link.status?.status ?? null) : null;
  return useRemoteAccess({
    computerName: name,
    hostClient,
    link: linkStatus,
    port,
    remote,
    signedIn:
      route.kind !== "browser" && deploymentAccess
        ? deploymentAccess.account.status === "signed-in"
        : null,
  });
}
