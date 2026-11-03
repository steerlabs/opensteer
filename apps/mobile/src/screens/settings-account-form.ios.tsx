import { Button, HStack, Section, Spacer, Text, Toggle } from "@expo/ui/swift-ui";
import { disabled, font, foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import {
  ActionButton,
  ErrorText,
  Footer,
  IdentityMark,
  Lines,
} from "./settings-form-primitives.ios.js";
import type { SettingsFormProps } from "./settings-form.types.js";
import { remoteAdministrationActionLabels, remoteAdministrationActions } from "./settings-model.js";
const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
const error = foregroundStyle(color.red);
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
              title="Open Opensteer from anywhere"
              footer={
                <Footer
                  text={
                    props.administration.access.operation?.detail ??
                    "Changes can disconnect this device and other devices."
                  }
                />
              }
            >
              {props.page === "account" ? (
                <Toggle
                  label="Open Opensteer from anywhere"
                  isOn={props.administration.access.access.mode !== "off"}
                  modifiers={[disabled(props.administration.busy)]}
                  onIsOnChange={(enabled) =>
                    props.administration?.onAction(enabled ? "mode" : "off")
                  }
                />
              ) : null}
              <Text>{props.administration.access.access.mode}</Text>
              {props.administration.access.access.accountLink ? (
                <Text>
                  {props.administration.access.access.accountLink.issuer} ·{" "}
                  {props.administration.access.access.accountLink.subject}
                </Text>
              ) : null}
              {remoteAdministrationActions(props.administration.access)
                .filter(
                  (action) =>
                    props.page !== "account" || !["off", "connect", "private"].includes(action),
                )
                .map((action) => (
                  <Button
                    key={action}
                    modifiers={[disabled(props.administration?.busy ?? false)]}
                    onPress={() => props.administration?.onAction(action)}
                  >
                    <Text>{remoteAdministrationActionLabels[action]}</Text>
                  </Button>
                ))}
              {props.administration.pairing ? (
                <Text>{props.administration.pairing.code}</Text>
              ) : null}
            </Section>
          ) : null}
          <Section title="Where you’re signed in">
            {props.administration.sessions.map((session) => (
              <HStack key={session.id}>
                <Text>
                  {session.deviceLabel}
                  {session.current ? " · This device" : ""}
                </Text>
                <Spacer />
                <Button
                  modifiers={[disabled(props.administration?.busy ?? false)]}
                  onPress={() => props.administration?.onRemove(session)}
                >
                  <Text>{props.page === "account" ? "Sign out" : "Remove"}</Text>
                </Button>
              </HStack>
            ))}
            <Button onPress={props.administration.onRefresh}>
              <Text>Refresh devices</Text>
            </Button>
            {props.administration.error ? (
              <Text modifiers={[error]}>{props.administration.error}</Text>
            ) : null}
          </Section>
        </>
      ) : null}
      {props.account === null ? null : (
        <Section title="Opensteer Account">
          <HStack alignment="center" spacing={12}>
            {props.account.initial === null ? null : (
              <IdentityMark circular initial={props.account.initial} />
            )}
            <Lines detail={props.account.subtitle} title={props.account.title} />
          </HStack>
          {props.account.detail === null ? null : (
            <Text modifiers={[secondary, footnote]}>{props.account.detail}</Text>
          )}
          <ActionButton action={props.account.action} onPress={props.onAccountAction} />
          <ErrorText detail={props.accountError} />
        </Section>
      )}
    </>
  );
}
