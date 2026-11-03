import {
  mutationIdempotencyKey,
  relocationPaths,
  type HostClient,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space } from "../theme.js";
import { AppText, CodeBlock, SecondaryButton } from "../ui/primitives.js";

type HealthAction =
  "workspace.adoptRelocated" | "workspace.storage.retry" | "workspace.deletion.recover";

/** Why a Project cannot take new work, and the one thing that fixes it. */
export interface ProjectHealth {
  readonly title: string;
  readonly detail: string;
  /** Where its folder is and where it must go, when the Host named both. */
  readonly paths: { readonly from: string; readonly to: string } | null;
  readonly action: { readonly type: HealthAction; readonly label: string } | null;
}

/**
 * What is wrong with a Project's folder, in the web's words, or null when it
 * can take work. Recovering a deletion is offered only to an owner, the one
 * person the Host lets keep it.
 */
export function projectHealth(
  workspace: Pick<WorkspaceSummary, "machineName" | "status" | "storageIssue">,
  owner: boolean,
): ProjectHealth | null {
  const issue = workspace.storageIssue;
  if (workspace.status === "provisioning") {
    return {
      title: "Preparing its folder",
      detail: "This usually takes a moment.",
      paths: null,
      action: null,
    };
  }
  if (issue?.code === "relocation-required") {
    const paths = relocationPaths(issue.message);
    return {
      title: "Move this project’s folder into Main",
      detail: paths
        ? "Opensteer keeps every project inside your Main folder. Move it from the first folder to the second on that computer, then tell Opensteer."
        : issue.message,
      paths,
      action: { type: "workspace.adoptRelocated", label: "I moved it" },
    };
  }
  if (issue?.code === "local-authority-unavailable") {
    return {
      title: "Its computer is offline",
      detail: `${workspace.machineName ?? "The computer that holds its folder"} isn’t connected. This project comes back as soon as it is.`,
      paths: null,
      action: null,
    };
  }
  if (workspace.status === "deleting") {
    return {
      title: "Scheduled for deletion",
      detail: owner
        ? "Its folder, chat and tasks are kept for a while, then removed for good. You can still keep it."
        : "Its folder, chat and tasks are kept for a while, then removed for good. An owner can still keep it.",
      paths: null,
      action: owner ? { type: "workspace.deletion.recover", label: "Keep this project" } : null,
    };
  }
  if (workspace.status === "failed" || issue !== null) {
    return {
      title: "Its folder needs attention",
      detail: issue?.message ?? "Its storage could not be set up.",
      paths: null,
      action: { type: "workspace.storage.retry", label: "Try again" },
    };
  }
  if (workspace.status === "unavailable") {
    return {
      title: "Temporarily unavailable",
      detail: "It comes back on its own.",
      paths: null,
      action: null,
    };
  }
  if (workspace.status === "archiving" || workspace.status === "archived") {
    return { title: "Archived", detail: "It takes no new work.", paths: null, action: null };
  }
  return null;
}

/**
 * A Project's folder problem, with its paths to copy and its fix. Nothing is
 * said for a healthy Project; the fix is held while Opensteer is offline,
 * because a confirmation that cannot arrive is one the person has to repeat.
 */
export function ProjectHealthNotice(props: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly owner: boolean;
  readonly workspace: WorkspaceSummary;
}): ReactNode {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const health = projectHealth(props.workspace, props.owner);
  if (health === null) return null;
  const { action } = health;
  const workspaceId = props.workspace.id;
  const run = (type: HealthAction): void => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    void props.hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey(`${type}:${workspaceId}`),
        type,
        workspaceId,
      })
      .catch((error: unknown) =>
        setFailure(operationDetail(error, "Opensteer could not confirm that. Try again.")),
      )
      .finally(() => setPending(false));
  };
  return (
    <View accessibilityRole="summary" style={styles.panel}>
      <AppText role="secondaryMedium">{health.title}</AppText>
      <AppText role="secondary" tone="soft">
        {health.detail}
      </AppText>
      {health.paths === null ? null : (
        <View style={styles.paths}>
          <CodeBlock label="From" text={health.paths.from} />
          <CodeBlock label="To" text={health.paths.to} />
        </View>
      )}
      {failure === null ? null : (
        <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
          <AppText role="secondary" tone="danger">
            {failure}
          </AppText>
        </View>
      )}
      {action === null ? null : (
        <View style={styles.action}>
          <SecondaryButton
            busy={pending}
            disabled={!props.connected}
            label={action.label}
            onPress={() => run(action.type)}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  action: { alignItems: "flex-start" },
  panel: {
    backgroundColor: color.amberWash,
    borderColor: color.amberLine,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[8],
    padding: space[16],
  },
  paths: { gap: space[8] },
});
