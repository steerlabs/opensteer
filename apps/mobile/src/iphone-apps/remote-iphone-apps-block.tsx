import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  computerAppAccessLabel,
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
import { AppText, Notice, RowGroup, SecondaryButton, SectionLabel } from "../ui/primitives.js";
import { IphoneAccessSheet, IphoneAppRow } from "./app-row.js";
import {
  iphoneAccessChoices,
  iphoneNarrowingReview,
  isIphoneAppId,
  type IphoneAccessChoice,
  type IphoneTone,
} from "./model.js";

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
  const [open, setOpen] = useState<string | null>(null);
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
  const rows = computerAppRows({ ...props.data, machine }).map((row) => {
    const request =
      requests.find(
        ({ definitionId, runnerId }) =>
          runnerId === machine.id && definitionId === row.definition.id,
      ) ?? null;
    return {
      request,
      row,
      status: iphoneAppStatus({ machineName: machine.name, request, row }),
    };
  });
  const opened = rows.find(({ row }) => row.definition.id === open) ?? null;
  const disabled = !props.canRespond || busy !== null;

  const commit = (row: ComputerAppRow, choice: IphoneAccessChoice): void => {
    setOpen(null);
    if (choice.action === "lower") {
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
      return;
    }
    if (choice.action !== "turn-off" || row.connectionId === null) return;
    const connectionId = row.connectionId;
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

  return (
    <View style={styles.section}>
      <SectionLabel>Apps agents can use</SectionLabel>
      {rows.length === 0 ? (
        <AppText role="secondary" tone="muted">
          {`Turn apps on in Opensteer on ${machine.name}.`}
        </AppText>
      ) : (
        <RowGroup>
          {rows.map(({ request, row, status }) => {
            const notice =
              row.access === null || row.state.kind === "off"
                ? null
                : computerAppPermissionNotice({
                    appName: row.definition.name,
                    machineName: machine.name,
                    platform: "ios",
                    state: row.state,
                  });
            return (
              <IphoneAppRow
                disabled={disabled || row.access === null}
                key={row.definition.id}
                line={status.text}
                name={row.definition.name}
                onPress={() => setOpen(row.definition.id)}
                tone={toneOf(status.tone)}
                {...(request === null
                  ? {}
                  : {
                      trailing: (
                        <SecondaryButton
                          accessibilityLabel={`Decline ${row.definition.name}`}
                          busy={busy === `decline:${row.definition.id}`}
                          compact
                          disabled={disabled}
                          label="Decline"
                          onPress={() =>
                            run(`decline:${row.definition.id}`, async () => {
                              const result = await hostClient.dispatch({
                                idempotencyKey: mutationIdempotencyKey(
                                  `iphone-app-decline:${row.definition.id}`,
                                ),
                                requestId: request.id,
                                type: "integration.computer.setup.cancel",
                              });
                              if (result.type !== "integration.computer.setup.cancel") {
                                throw new Error("The request is still waiting.");
                              }
                            })
                          }
                        />
                      ),
                    })}
              >
                {notice === null ? null : (
                  <View style={styles.notice}>
                    <Notice detail={notice.detail} title={notice.title} tone="neutral" />
                  </View>
                )}
                <FailureText
                  detail={
                    failureFor(row.definition.id) ?? failureFor(`decline:${row.definition.id}`)
                  }
                />
              </IphoneAppRow>
            );
          })}
        </RowGroup>
      )}
      {opened === null || !isIphoneAppId(opened.row.definition.id) ? null : (
        <IphoneAccessSheet
          busy={busy !== null}
          choices={iphoneAccessChoices({
            app: opened.row.definition.id,
            current: opened.row.access,
            definition: opened.row.definition,
            here: false,
          })}
          facts={{
            access:
              opened.row.access === null
                ? "Off"
                : computerAppAccessLabel(opened.row.presentation, opened.row.access),
            permission: remotePermission(opened.row, machine.name),
          }}
          name={opened.row.definition.name}
          onClose={() => setOpen(null)}
          onCommit={(choice) => commit(opened.row, choice)}
          onOpenSettings={null}
          review={(choice) =>
            isIphoneAppId(opened.row.definition.id)
              ? iphoneNarrowingReview({
                  app: opened.row.definition.id,
                  choice,
                  name: opened.row.definition.name,
                })
              : null
          }
          summary={{
            text: `Only ${machine.name} can turn ${opened.row.definition.name} on or give it more access. You can lower it or turn it off from here, even while ${machine.name} is offline.`,
            tone: toneOf(opened.status.tone),
          }}
        />
      )}
    </View>
  );
}

/** What iPhone Settings lets Opensteer do, as far as another device can know it. */
function remotePermission(row: ComputerAppRow, machineName: string): string {
  switch (row.readState.kind) {
    case "ready":
      return "Allowed";
    case "permission-required":
      return "Not allowed";
    case "offline":
      return `Unknown while ${machineName} is offline`;
    case "checking":
      return "Checking…";
    case "unavailable":
      return "Unknown";
  }
}

function toneOf(tone: "attention" | "idle" | "on"): IphoneTone {
  return tone === "on" ? "green" : tone === "attention" ? "amber" : "muted";
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", paddingVertical: space[24] },
  notice: { paddingBottom: space[12], paddingHorizontal: space[16] },
  section: { gap: space[8] },
});
