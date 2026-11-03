import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText, RowGroup, SecondaryButton, SwitchRow } from "../ui/primitives.js";
import {
  actionRow,
  AvatarInitial,
  ErrorText,
  Section,
  styles,
} from "./settings-form-primitives.js";
import type { SettingsFormProps } from "./settings-form.types.js";
import { remoteAdministrationActionLabels, remoteAdministrationActions } from "./settings-model.js";
export function AccountSettingsForm(
  props: Pick<
    SettingsFormProps,
    "page" | "administration" | "account" | "accountError" | "onAccountAction"
  >,
): ReactNode {
  return (
    <>
      {props.administration ? (
        <>
          {props.administration.access ? (
            <Section
              label="Open Opensteer from anywhere"
              footer={
                props.administration.access.operation?.detail ??
                "Changes can disconnect this device and other devices."
              }
            >
              {props.page === "account" ? (
                <SwitchRow
                  label="Open Opensteer from anywhere"
                  value={props.administration.access.access.mode !== "off"}
                  disabled={props.administration.busy}
                  onChange={(enabled) => props.administration?.onAction(enabled ? "mode" : "off")}
                />
              ) : null}
              <AppText>{props.administration.access.access.mode}</AppText>
              {props.administration.access.access.accountLink ? (
                <AppText>
                  {props.administration.access.access.accountLink.issuer} ·{" "}
                  {props.administration.access.access.accountLink.subject}
                </AppText>
              ) : null}
              {remoteAdministrationActions(props.administration.access)
                .filter(
                  (action) =>
                    props.page !== "account" || !["off", "connect", "private"].includes(action),
                )
                .map((action) => (
                  <SecondaryButton
                    key={action}
                    compact
                    disabled={props.administration?.busy ?? false}
                    label={remoteAdministrationActionLabels[action]}
                    onPress={() => props.administration?.onAction(action)}
                  />
                ))}
              {props.administration.pairing ? (
                <AppText>{props.administration.pairing.code}</AppText>
              ) : null}
            </Section>
          ) : null}
          <Section label="Where you’re signed in">
            {props.administration.sessions.map((session) => (
              <View key={session.id}>
                <AppText>
                  {session.deviceLabel}
                  {session.current ? " · This device" : ""}
                </AppText>
                <SecondaryButton
                  compact
                  disabled={props.administration?.busy ?? false}
                  label={props.page === "account" ? "Sign out" : "Remove"}
                  onPress={() => props.administration?.onRemove(session)}
                />
              </View>
            ))}
            <SecondaryButton
              compact
              label="Refresh sessions"
              onPress={props.administration.onRefresh}
            />
            {props.administration.error ? <AppText>{props.administration.error}</AppText> : null}
          </Section>
        </>
      ) : null}
      {props.account === null ? null : (
        <Section label="Opensteer Account">
          <RowGroup>
            {[
              <View key="identity" style={styles.row}>
                <View style={styles.identity}>
                  {props.account.initial === null ? null : (
                    <AvatarInitial initial={props.account.initial} />
                  )}
                  <View style={styles.text}>
                    <AppText role="body">{props.account.title}</AppText>
                    {props.account.subtitle === null ? null : (
                      <AppText role="secondary" tone="muted">
                        {props.account.subtitle}
                      </AppText>
                    )}
                  </View>
                </View>
                {props.account.detail === null ? null : (
                  <AppText role="secondary" tone="soft">
                    {props.account.detail}
                  </AppText>
                )}
              </View>,
              actionRow(props.account.action, props.onAccountAction, "account-action"),
            ]}
          </RowGroup>
          <ErrorText detail={props.accountError} />
        </Section>
      )}
    </>
  );
}
