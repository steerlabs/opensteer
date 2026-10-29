import { useEffect, useState, type ReactNode } from "react";
import { AppState, StyleSheet, View } from "react-native";
import type { IphoneAppsApproval } from "../platform/iphone-apps.js";
import { space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { IphoneApprovalCard } from "./approval-card.js";
import { useIphoneAppsState } from "./context.js";
import type { IphoneAppsController } from "./controller.js";
import {
  iphoneAnswerFailure,
  iphoneAppName,
  iphoneDisclosure,
  iphoneTaskScope,
  opensteerOn,
} from "./model.js";

/**
 * A request waiting on this iPhone, put in front of the person once, over
 * whatever is on screen and whichever Deployment is open — the iPhone answers
 * only for the one it was added to. Closing it is "Not now": the request stays
 * on the iPhone's Computer page until it is answered or expires.
 */
export function IphoneApprovalPrompt(props: {
  readonly controller: IphoneAppsController;
  /** `{Opensteer}` for a Deployment, by the name this phone lists it under. */
  readonly opensteerFor: (deploymentId: string) => string;
}): ReactNode {
  const { controller } = props;
  const state = useIphoneAppsState(controller);
  const [active, setActive] = useState(AppState.currentState === "active");
  const [showing, setShowing] = useState<IphoneAppsApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setActive(next === "active"),
    );
    return () => subscription.remove();
  }, []);

  const next = state.prompt;
  useEffect(() => {
    if (showing !== null || !active || next === null) return;
    setFailure(null);
    setShowing(next);
    controller.markShown(next.setupRequestId);
  }, [active, controller, next, showing]);

  // A request answered elsewhere, or expired, leaves the iPhone's list and the sheet with it.
  const listed =
    showing !== null &&
    state.snapshot.approvals.some(
      ({ setupRequestId }) => setupRequestId === showing.setupRequestId,
    );
  useEffect(() => {
    if (showing !== null && !listed && !busy) setShowing(null);
  }, [busy, listed, showing]);

  const answer = (decision: "allow" | "deny"): void => {
    if (showing === null || busy) return;
    setBusy(true);
    setFailure(null);
    void controller
      .answer({ decision, setupRequestId: showing.setupRequestId })
      .then((outcome) => {
        const failure = iphoneAnswerFailure(outcome, iphoneAppName(showing.definitionId));
        if (failure === null) setShowing(null);
        else setFailure(failure);
      })
      .finally(() => setBusy(false));
  };

  const deploymentId = state.snapshot.enrollment?.deploymentId ?? null;
  const title =
    deploymentId === null ? opensteerOn("this iPhone") : props.opensteerFor(deploymentId);
  return (
    <Sheet onClose={() => setShowing(null)} open={showing !== null} title={title}>
      {showing === null ? null : (
        <View style={styles.body}>
          <IphoneApprovalCard
            approval={showing}
            busy={busy}
            failure={failure}
            name={iphoneAppName(showing.definitionId)}
            onAllow={() => answer("allow")}
            onDeny={() => answer("deny")}
          />
          <AppText role="caption" style={styles.disclosure} tone="muted">
            {`${iphoneTaskScope} ${iphoneDisclosure(title)}`}
          </AppText>
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: space[8], paddingTop: space[8] },
  disclosure: { paddingHorizontal: space[16] },
});
