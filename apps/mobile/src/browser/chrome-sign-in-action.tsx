import { BrowserSurfaceIdSchema } from "@opensteer/core";
import {
  browserSignInProblemCopy,
  browserSiteLabel,
  chromeCandidateDetail,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import type {
  BrowserSignInOutcome,
  BrowserSourceInspection,
} from "@opensteer/protocol/browser-sources";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { ChromeChoice, ChromeChoices } from "./chrome-sign-in-parts.js";

type Result =
  | { readonly kind: "signed-in"; readonly message: string }
  | { readonly kind: "problem"; readonly fix: string | null; readonly title: string }
  | {
      readonly kind: "choose";
      readonly candidates: BrowserSourceInspection["candidates"];
      readonly site: string;
    };

/** How long the one reload waits for the interactive channel to be ready. */
const reloadConnectMs = 10_000;

/** Holds the interactive channel until the explicitly requested reload is sent. */
async function reloadOnce(
  hostClient: Pick<
    HostClient,
    | "browserViewerState"
    | "browserFrames"
    | "subscribeBrowserViewer"
    | "retainBrowserViewer"
    | "sendBrowserCommand"
  >,
  sessionId: string,
  tabId: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  const synchronized = () => hostClient.browserViewerState(sessionId, tabId).status === "live";
  const release = hostClient.retainBrowserViewer(sessionId, tabId);
  try {
    const ready =
      synchronized() ||
      (await new Promise<boolean>((resolve) => {
        let unsubscribe: () => void = () => undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (connected: boolean) => {
          clearTimeout(timer);
          unsubscribe();
          signal.removeEventListener("abort", left);
          resolve(connected);
        };
        const left = () => finish(false);
        timer = setTimeout(left, reloadConnectMs);
        signal.addEventListener("abort", left, { once: true });
        const changed = () => {
          if (synchronized()) finish(true);
        };
        unsubscribe =
          hostClient.subscribeBrowserViewer?.(sessionId, tabId, changed) ??
          hostClient.browserFrames.subscribe(sessionId, changed, tabId);
        changed();
      }));
    if (!ready || signal.aborted) return false;
    hostClient.sendBrowserCommand(sessionId, {
      type: "navigation.reload",
      surfaceId: BrowserSurfaceIdSchema.parse(tabId),
    });
    return true;
  } catch {
    return false;
  } finally {
    release();
  }
}

/**
 * Signs the page's site in, in this browser, with the person's own Chrome
 * sign-in, then reloads the page so it shows the signed-in site.
 *
 * The component is keyed by session and site, so a result never outlives the
 * page it was about.
 */
export function ChromeSignInAction(props: {
  readonly connected: boolean;
  readonly hostClient: Pick<
    HostClient,
    | "dispatch"
    | "browserViewerState"
    | "browserFrames"
    | "subscribeBrowserViewer"
    | "retainBrowserViewer"
    | "rpc"
    | "sendBrowserCommand"
  >;
  readonly sessionId: string;
  readonly tabId: string;
  /** The page's site; the component is keyed by it. */
  readonly site: string;
  readonly url: string;
  /** The session's Workspace, whose agents may use the site once it is signed in. */
  readonly workspaceName: string;
}): ReactNode {
  const { hostClient, sessionId, tabId, url } = props;
  const [busy, setBusy] = useState(false);
  // Read synchronously, so a second tap before the next render finds it set.
  const inFlight = useRef(false);
  const [result, setResult] = useState<Result | null>(null);
  const attempt = useRef<{ key: string; sourceId: string | null } | null>(null);
  // Aborted when the screen is left: nothing is reloaded or said after that.
  const presence = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    presence.current = controller;
    return () => controller.abort();
  }, []);

  const show = (next: Result, left: AbortSignal) => {
    if (left.aborted) return;
    setResult(next);
    if (next.kind !== "choose") {
      void AccessibilityInfo.announceForAccessibility(
        next.kind === "signed-in"
          ? next.message
          : next.fix === null
            ? `${next.title}.`
            : `${next.title}. ${next.fix}`,
      );
    }
  };

  const signIn = async (sourceId: string | null): Promise<void> => {
    const left = presence.current?.signal;
    if (inFlight.current || left === undefined) return;
    inFlight.current = true;
    // A retry of the same choice is the same command, so a lost answer is not a second sign-in.
    if (attempt.current?.sourceId !== sourceId) {
      attempt.current = { key: mutationIdempotencyKey("browser-session-sign-in"), sourceId };
    }
    const { key } = attempt.current;
    setBusy(true);
    try {
      const response = await hostClient.dispatch({
        idempotencyKey: key,
        sessionId,
        sourceId,
        type: "browser.session.sign-in",
        url,
      });
      if (response.type !== "browser.session.sign-in") throw new Error("Unexpected answer.");
      attempt.current = null;
      await settle(response.outcome, left);
    } catch (error) {
      show(
        {
          fix: operationDetail(error, "Try again."),
          kind: "problem",
          title: "Sign-in didn’t finish",
        },
        left,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const settle = async (outcome: BrowserSignInOutcome, left: AbortSignal): Promise<void> => {
    const domain = browserSiteLabel(outcome.site);
    if (outcome.status === "applied") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const reloaded = await reloadOnce(hostClient, sessionId, tabId, left);
      const saved = outcome.profileName === null ? "" : ` Saved to profile ${outcome.profileName}.`;
      show(
        {
          kind: "signed-in",
          message: `Signed in to ${domain} with ${outcome.sourceName}.${saved}${
            reloaded ? " Reloading the page." : " Reload the page to finish signing in."
          }`,
        },
        left,
      );
      return;
    }
    if (outcome.problem === "choose-source") {
      const inspection = unwrapRpcResult(await hostClient.rpc["browser.sources.inspect"]({ url }));
      if (left.aborted) return;
      setResult({ candidates: inspection.candidates, kind: "choose", site: outcome.site });
      void AccessibilityInfo.announceForAccessibility(
        `Several Chrome profiles are signed in to ${domain}. Choose one.`,
      );
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    show(
      {
        ...browserSignInProblemCopy(outcome.problem, {
          connectHere: false,
          context: "page",
          site: outcome.site,
          sourceName: outcome.sourceName,
        }),
        kind: "problem",
      },
      left,
    );
  };

  const domain = browserSiteLabel(props.site);
  return (
    <View style={styles.block}>
      <Pressable
        accessibilityHint={`Uses your ${domain} sign-in from Chrome on this page, then reloads the page.`}
        accessibilityLabel="Sign in with Chrome"
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy || !props.connected }}
        disabled={busy || !props.connected}
        onPress={() => void signIn(null)}
        style={({ pressed }) => [
          styles.action,
          pressed && styles.pressed,
          !props.connected && styles.disabled,
        ]}
      >
        <AppText role="secondaryMedium" tone="ember">
          Sign in with Chrome
        </AppText>
        {busy ? <ActivityIndicator color={color.ember} /> : null}
      </Pressable>
      <AppText role="caption" tone="muted">
        {`Agents in ${props.workspaceName} will be able to use ${domain} as you.`}
      </AppText>
      {result === null ? null : result.kind === "signed-in" ? (
        <AppText role="caption" tone="soft">
          {result.message}
        </AppText>
      ) : result.kind === "problem" ? (
        <View style={styles.problem}>
          <AppText role="secondaryMedium">{result.title}</AppText>
          {result.fix === null ? null : (
            <AppText role="caption" tone="soft">
              {result.fix}
            </AppText>
          )}
        </View>
      ) : (
        <View style={styles.problem}>
          <AppText role="secondaryMedium">{`Choose the Chrome to use for ${browserSiteLabel(result.site)}`}</AppText>
          <ChromeChoices>
            {result.candidates.map((candidate) => (
              <ChromeChoice
                checked={false}
                detail={chromeCandidateDetail(candidate, result.site)}
                disabled={busy || candidate.status !== "available"}
                key={candidate.sourceId}
                label={candidate.name}
                onPress={() => void signIn(candidate.sourceId)}
              />
            ))}
          </ChromeChoices>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
  },
  block: { gap: space[6] },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.68 },
  problem: { gap: space[6] },
});
