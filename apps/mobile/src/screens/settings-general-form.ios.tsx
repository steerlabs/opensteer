import { Button, HStack, LabeledContent, Section, Spacer, Text, Toggle } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import {
  ActionButton,
  Chevron,
  ErrorText,
  Footer,
  IdentityMark,
  Lines,
} from "./settings-form-primitives.ios.js";
import type { SettingsFormProps } from "./settings-form.types.js";
import { projectNotificationsFooter } from "./settings-model.js";
const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
export function GeneralSettingsForm(
  props: Pick<
    SettingsFormProps,
    | "page"
    | "deployment"
    | "desktopUpdate"
    | "notifications"
    | "notificationError"
    | "agents"
    | "onDeploymentAction"
    | "onNotificationAction"
    | "onPreferenceChange"
    | "onAgentMuteChange"
    | "storageError"
    | "version"
  >,
): ReactNode {
  const notifications = props.notifications;
  const preferences = notifications?.preferences ?? null;
  const update = props.desktopUpdate;
  return (
    <>
      {
        <Section title="Deployment">
          <Button
            modifiers={[
              accessibilityLabel(
                `${props.deployment.title}, ${props.deployment.status}. ${props.deployment.action.label}`,
              ),
            ]}
            onPress={props.onDeploymentAction}
          >
            <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
              <IdentityMark mark={props.deployment.mark} />
              <Lines detail={props.deployment.status} title={props.deployment.title} />
              <Spacer />
              <Text modifiers={[secondary, font({ textStyle: "subheadline" })]}>
                {props.deployment.action.label}
              </Text>
              <Chevron />
            </HStack>
          </Button>
        </Section>
      }
      {update === null ? null : (
        <Section title={update.view.title}>
          <Lines detail={update.view.statusLine} title={update.view.headline} />
          {update.view.versionLine === null ? null : (
            <LabeledContent label={update.view.versionLine}>
              <Text modifiers={[secondary]}>{update.view.channel ?? ""}</Text>
            </LabeledContent>
          )}
          {update.view.result === null ? null : update.view.result.tone === "attention" ? (
            <ErrorText detail={update.view.result.text} />
          ) : (
            <Text modifiers={[secondary, footnote]}>{update.view.result.text}</Text>
          )}
          {[update.view.action, update.view.channelAction].map((action) =>
            action === null ? null : (
              <Button
                key={action.label}
                label={action.label}
                onPress={() => update.onAction(action)}
              />
            ),
          )}
        </Section>
      )}
      {notifications === null ? null : (
        <Section footer={<Footer text={notifications.footer} />} title="Notifications">
          {notifications.detail === null ? null : (
            <Text modifiers={[secondary, footnote]}>{notifications.detail}</Text>
          )}
          {preferences === null ? null : (
            <Toggle
              isOn={preferences.approvalsEnabled}
              label="Approvals and questions"
              modifiers={[disabled(notifications.disabled)]}
              onIsOnChange={(enabled) => props.onPreferenceChange("approvals", enabled)}
            />
          )}
          {preferences === null ? null : (
            <Toggle
              isOn={preferences.runOutcomesEnabled}
              label="Replies and updates"
              modifiers={[disabled(notifications.disabled)]}
              onIsOnChange={(enabled) => props.onPreferenceChange("run-outcomes", enabled)}
            />
          )}
          <ActionButton action={notifications.action} onPress={props.onNotificationAction} />
          <ErrorText detail={props.notificationError} />
        </Section>
      )}
      {notifications === null || props.agents.length === 0 ? null : (
        <Section
          footer={<Footer text={projectNotificationsFooter} />}
          title="Notifications from projects"
        >
          {props.agents.map((agent) => (
            <Toggle
              isOn={!agent.muted}
              key={agent.workspaceId}
              label={agent.name}
              onIsOnChange={(enabled) => props.onAgentMuteChange(agent.workspaceId, !enabled)}
            />
          ))}
        </Section>
      )}
      {
        <Section title="About">
          <LabeledContent label="Version">
            <Text modifiers={[secondary]}>{props.version}</Text>
          </LabeledContent>
          <ErrorText
            detail={
              props.storageError === null
                ? null
                : `This phone could not save a setting. ${props.storageError}`
            }
          />
        </Section>
      }
    </>
  );
}
