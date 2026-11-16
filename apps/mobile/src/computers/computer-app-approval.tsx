import { Pressable, StyleSheet, View } from "react-native";
import { AppText, CodeBlock, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { Symbol } from "../ui/symbol.js";
import {
  useComputerAppApproval as useOwnerComputerAppApproval,
  useThreadServerApprovals,
} from "@opensteer/client/react";
import {
  computerAppApprovalSecretFields,
  localMcpSecretsToSend,
  type ComputerAppApprovalReview,
  type ComputerAppApprovalView,
} from "@opensteer/client/integrations";
import type { HostClient } from "@opensteer/client/host";
import { useState, type ReactNode } from "react";

import { color, controlFontScaleLimit, material, radius, space } from "../theme.js";
import { MacAppIcon } from "./app-mark.js";
import { LocalMcpSecretFields } from "./local-mcp-secret-fields.js";

/**
 * `content` is the review itself; `dialog` puts it in its own sheet. iOS shows
 * one modal at a time, so a surface already in a sheet renders `content` there.
 */
export function useComputerAppApproval(hostClient: HostClient) {
  const { ask, review, view, error, busy, close, answer } = useOwnerComputerAppApproval(hostClient);
  const content =
    review && view ? (
      <ApprovalReview
        // A new review starts with empty fields.
        key={review.request.id}
        answer={answer}
        busy={busy}
        error={error}
        hostClient={hostClient}
        review={review}
        view={view}
      />
    ) : null;
  const dialog =
    content === null || view === null ? null : (
      <Sheet onClose={close} open title={view.title}>
        <View style={styles.dialog}>{content}</View>
      </Sheet>
    );
  return { ask, close, content, dialog };
}

function ApprovalReview(props: {
  readonly answer: (
    decision: "allow" | "deny",
    secrets?: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly hostClient: HostClient;
  readonly review: ComputerAppApprovalReview;
  readonly view: ComputerAppApprovalView;
}) {
  const { view } = props;
  const fields = computerAppApprovalSecretFields(props.review);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [invalid, setInvalid] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const allow = () => {
    const entered = localMcpSecretsToSend(fields, values);
    if (!entered.ok) {
      setInvalid(entered.message);
      return;
    }
    setInvalid(null);
    void props.answer("allow", entered.secrets);
  };
  const error = invalid ?? props.error;
  return (
    <View style={styles.review}>
      <View style={styles.identity}>
        <ApprovalMark hostClient={props.hostClient} view={view} />
        <View style={styles.identityText}>
          <AppText role="bodyMedium">{view.name}</AppText>
          {view.context ? (
            <AppText numberOfLines={2} role="caption" tone="muted">
              {view.context}
            </AppText>
          ) : null}
        </View>
      </View>
      <View style={styles.abilities}>
        {view.abilities.map((ability) => (
          <View key={ability.text} style={styles.ability}>
            <Symbol
              name={ability.allowed ? "checkmark" : "xmark"}
              size={14}
              tint={ability.allowed ? color.green : color.muted}
              weight="semibold"
            />
            <AppText
              role="secondary"
              style={styles.abilityText}
              tone={ability.allowed ? "soft" : "muted"}
            >
              {ability.text}
            </AppText>
          </View>
        ))}
      </View>
      {view.warning ? (
        <View style={styles.warning}>
          <Symbol name="exclamationmark.triangle.fill" size={14} tint={color.amber} />
          <AppText role="caption" style={styles.warningText}>
            {view.warning}
          </AppText>
        </View>
      ) : null}
      <LocalMcpSecretFields
        disabled={props.busy}
        fields={fields}
        onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
        values={values}
      />
      {view.details ? (
        <View style={styles.details}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: detailsOpen }}
            hitSlop={space[8]}
            onPress={() => setDetailsOpen((open) => !open)}
            style={styles.disclosure}
          >
            <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
              {view.details.label}
            </AppText>
            <Symbol
              name={detailsOpen ? "chevron.down" : "chevron.right"}
              size={10}
              tint={color.muted}
              weight="semibold"
            />
          </Pressable>
          {detailsOpen ? <CodeBlock text={view.details.text} /> : null}
        </View>
      ) : null}
      {error ? (
        <AppText role="secondary" tone="danger">
          {error}
        </AppText>
      ) : null}
      <View style={styles.answers}>
        <View style={styles.answer}>
          <SecondaryButton
            disabled={props.busy}
            label="Don't allow"
            onPress={() => void props.answer("deny")}
          />
        </View>
        <View style={styles.answer}>
          <PrimaryButton disabled={props.busy} label="Allow" onPress={allow} />
        </View>
      </View>
    </View>
  );
}

function ApprovalMark(props: {
  readonly hostClient: HostClient;
  readonly view: ComputerAppApprovalView;
}): ReactNode {
  if (props.view.app)
    return (
      <MacAppIcon
        app={props.view.app}
        hostClient={props.hostClient}
        machineId={props.view.runnerId}
        size={markSize}
      />
    );
  return (
    <View style={styles.glyph}>
      <Symbol
        name={props.view.kind === "server" ? "puzzlepiece.extension" : "square.grid.2x2"}
        size={20}
        tint={color.textSoft}
      />
    </View>
  );
}

const markSize = 40;

export function ComputerSetupApprovals(props: {
  readonly hostClient: HostClient;
  readonly requests: readonly import("@opensteer/client/integrations").ComputerAppSetupSummary[];
  readonly onChanged: () => Promise<void>;
}) {
  const approval = useComputerAppApproval(props.hostClient);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function review(id: string) {
    setBusy(id);
    setError(null);
    try {
      await approval.ask(id);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't review this approval.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <View>
      {approval.dialog}
      {props.requests.map((request) => (
        <View key={request.id}>
          <AppText role="body">
            {request.server?.name ??
              request.app?.displayName ??
              (request.kind === "policy" ? "Automatic app approval" : request.definitionId)}
          </AppText>
          <SecondaryButton
            label="Review"
            disabled={busy !== null}
            onPress={() => void review(request.id)}
          />
        </View>
      ))}
      {error ? <AppText role="body">{error}</AppText> : null}
    </View>
  );
}

/** Plugin servers an agent in this Thread installed, waiting for the owner to allow them to start. */
export function ThreadServerApprovals(props: {
  readonly hostClient: HostClient;
  readonly threadId: string;
}) {
  const { requests, reload } = useThreadServerApprovals(props.hostClient, props.threadId);
  if (requests.length === 0) return null;
  return (
    <View style={styles.threadCard}>
      <AppText role="caption" tone="ember">
        Needs you
      </AppText>
      <ComputerSetupApprovals
        hostClient={props.hostClient}
        onChanged={reload}
        requests={requests}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  ability: { alignItems: "center", flexDirection: "row", gap: space[10] },
  abilities: { gap: space[8] },
  abilityText: { flex: 1 },
  answer: { flex: 1 },
  answers: { flexDirection: "row", gap: space[10], marginTop: space[4] },
  details: { gap: space[8] },
  dialog: { paddingHorizontal: space[16], paddingTop: space[8] },
  disclosure: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: space[4],
  },
  glyph: {
    ...material.plate,
    alignItems: "center",
    borderRadius: markSize * 0.225,
    height: markSize,
    justifyContent: "center",
    width: markSize,
  },
  identity: { alignItems: "center", flexDirection: "row", gap: space[12] },
  identityText: { flex: 1, gap: space[2] },
  review: { gap: space[16] },
  threadCard: {
    ...material.attention,
    borderRadius: radius.lg,
    gap: space[6],
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  warning: {
    alignItems: "flex-start",
    backgroundColor: color.amberWash,
    borderColor: color.amberLine,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[8],
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  warningText: { color: color.amber, flex: 1 },
});
