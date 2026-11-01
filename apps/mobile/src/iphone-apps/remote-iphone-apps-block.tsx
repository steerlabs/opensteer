import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  computerAppPermissionNotice,
  computerAppRows,
  iphoneAppStatus,
  type ComputerAppRow,
  type ComputerUseData,
} from "@opensteer/client/integrations";
import type { MachineSummary } from "@opensteer/protocol";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { FailureText, useBlockActions } from "../computers/block-actions.js";
import { color, space } from "../theme.js";
import {
  AppText,
  Notice,
  RowGroup,
  SecondaryButton,
  SectionLabel,
  Toggle,
} from "../ui/primitives.js";
import { IphoneAppRow } from "./app-row.js";
import { iphoneLevels, isIphoneAppId, type IphoneTone } from "./model.js";

/**
 * Another device's iPhone, from this phone. New or wider access is approved
 * on the iPhone that holds the data, so here an app that is off says where it
 * is turned on, a waiting request can only be declined, and an app that is on
 * can be lowered or turned off — the changes that narrow access. Those need
 * only the Host, so they stay available while the iPhone is offline and while
 * a request for more access waits.
 */
export function RemoteIphoneAppsBlock(props: {
  /** False while the Host is unreachable: nothing is changed on a guess. */
  readonly canRespond: boolean;
  readonly data: ComputerUseData | null;
  readonly hostClient: HostClient;
  readonly machine: MachineSummary;
  readonly onChanged: () => Promise<void>;
}): ReactNode {
  const { hostClient, machine } = props;
  const { busy, failureFor, run } = useBlockActions(props.canRespond, props.onChanged);
  // The app being turned off, whose switch shows off until the Host's answer lands.
  const [turningOff, setTurningOff] = useState<string | null>(null);
  if (machine.ownership === "other") {
    return (
      <AppText role="secondary" tone="muted">
        {`${machine.ownerName ?? "Its owner"} chooses which apps agents can use on ${machine.name}.`}
      </AppText>
    );
  }
  if (props.data === null) {
    return (
      <View accessibilityLabel="Loading apps" style={styles.loading}>
        <ActivityIndicator color={color.muted} />
      </View>
    );
  }
  const requests = props.data.setupRequests;
  const rows = computerAppRows({ ...props.data, machine }).flatMap((row) => {
    const app = row.definition.id;
    if (!isIphoneAppId(app)) return [];
    const request =
      requests.find(
        ({ definitionId, runnerId }) => runnerId === machine.id && definitionId === app,
      ) ?? null;
    return [
      { app, request, row, status: iphoneAppStatus({ machineName: machine.name, request, row }) },
    ];
  });
  const disabled = !props.canRespond || busy !== null;
  const disabledReason = !props.canRespond
    ? "Opensteer can't be reached right now."
    : busy !== null
      ? "Wait for the current change to finish."
      : null;

  const lower = (row: ComputerAppRow): void => {
    setTurningOff(null);
    run(row.definition.id, async () => {
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`iphone-app:${row.definition.id}`),
        input: {
          access: "read",
          app: null,
          definitionId: row.definition.id,
          kind: "app",
          runnerId: machine.id,
        },
        type: "integration.computer.setup.set",
      });
      if (result.type !== "integration.computer.setup.set") {
        throw new Error(`${row.definition.name} did not change.`);
      }
    });
  };

  const turnOff = (row: ComputerAppRow): void => {
    const connectionId = row.connectionId;
    if (connectionId === null) return;
    setTurningOff(row.definition.id);
    run(row.definition.id, async () => {
      const result = await hostClient.dispatch({
        connectionId,
        idempotencyKey: mutationIdempotencyKey(`iphone-app-off:${row.definition.id}`),
        type: "integration.disconnect",
      });
      if (result.type !== "integration.disconnect") {
        throw new Error(`${row.definition.name} is still on.`);
      }
    });
  };

  const decline = (row: ComputerAppRow, requestId: string): void => {
    run(`decline:${row.definition.id}`, async () => {
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`iphone-app-decline:${row.definition.id}`),
        requestId,
        type: "integration.computer.setup.cancel",
      });
      if (result.type !== "integration.computer.setup.cancel") {
        throw new Error("The request is still waiting.");
      }
    });
  };

  return (
    <View style={styles.section}>
      <SectionLabel>Apps agents can use</SectionLabel>
      {rows.length === 0 ? (
        <AppText role="secondary" tone="muted">
          {`Turn apps on in Opensteer on ${machine.name}.`}
        </AppText>
      ) : (
        <RowGroup>
          {rows.map(({ app, request, row, status }) => {
            const on = row.access !== null && row.state.kind !== "off";
            const notice = !on
              ? null
              : computerAppPermissionNotice({
                  appName: row.definition.name,
                  machineName: machine.name,
                  platform: "ios",
                  state: row.state,
                });
            return (
              <IphoneAppRow
                app={app}
                disabledReason={disabledReason}
                key={app}
                levels={
                  row.access === null
                    ? []
                    : iphoneLevels({
                        app,
                        current: row.access,
                        definition: row.definition,
                        here: false,
                      })
                }
                line={status.text}
                name={row.definition.name}
                onLevel={() => lower(row)}
                tone={toneOf(status.tone)}
                trailing={
                  <Toggle
                    accessibilityHint={
                      on ? status.text : `Only ${machine.name} can turn ${row.definition.name} on.`
                    }
                    accessibilityLabel={row.definition.name}
                    disabled={disabled || row.access === null}
                    onChange={(value) => {
                      if (!value) turnOff(row);
                    }}
                    value={row.access !== null && !(busy === app && turningOff === app)}
                  />
                }
              >
                {request === null ? null : (
                  <View style={styles.request}>
                    <AppText role="caption" style={styles.requestText} tone="muted">
                      {`A task asked for ${row.definition.name}. Only ${machine.name} can allow it.`}
                    </AppText>
                    <SecondaryButton
                      accessibilityLabel={`Decline ${row.definition.name}`}
                      busy={busy === `decline:${app}`}
                      compact
                      disabled={disabled}
                      label="Decline"
                      onPress={() => decline(row, request.id)}
                    />
                  </View>
                )}
                {notice === null ? null : (
                  <View style={styles.notice}>
                    <Notice detail={notice.detail} title={notice.title} tone="neutral" />
                  </View>
                )}
                <FailureText detail={failureFor(app) ?? failureFor(`decline:${app}`)} />
              </IphoneAppRow>
            );
          })}
        </RowGroup>
      )}
      <AppText role="caption" tone="muted">
        {`Only ${machine.name} can turn apps on or give them more access. You can lower or turn them off here, even while it's offline.`}
      </AppText>
    </View>
  );
}

function toneOf(tone: "attention" | "idle" | "on"): IphoneTone {
  return tone === "on" ? "green" : tone === "attention" ? "amber" : "muted";
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", paddingVertical: space[24] },
  notice: { paddingBottom: space[12], paddingHorizontal: space[16] },
  request: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    paddingBottom: space[12],
    paddingHorizontal: space[16],
  },
  requestText: { flex: 1 },
  section: { gap: space[8] },
});
