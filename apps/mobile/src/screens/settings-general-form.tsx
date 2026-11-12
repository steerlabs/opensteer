import type { ReactNode } from "react";
import { Linking, View } from "react-native";
import { DeploymentMarkView } from "../threads/deployment-mark.js";
import { ChoiceMenu } from "../ui/choice-menu.js";
import { deploymentUpdateRows } from "./deployment-update.js";
import { AppText, RowGroup, SwitchRow } from "../ui/primitives.js";
import { actionRow, ErrorText, LinkRow, Section, styles } from "./settings-form-primitives.js";
import type { SettingsFormProps } from "./settings-form.types.js";
import {
  privacyPolicyUrl,
  quietTaskChoices,
  quietTasksFooter,
  quietTasksTitle,
} from "./settings-model.js";
export function GeneralSettingsForm(
  props: Pick<
    SettingsFormProps,
    | "page"
    | "deployment"
    | "desktopUpdate"
    | "notifications"
    | "notificationError"
    | "onDeploymentAction"
    | "onNotificationAction"
    | "onPreferenceChange"
    | "storageError"
    | "quietTasks"
    | "version"
  >,
): ReactNode {
  const quietTasks = props.quietTasks ?? null;
  const quietLabel =
    quietTasks === null
      ? ""
      : (quietTaskChoices.find((choice) => choice.days === quietTasks.days)?.label ?? "");
  const notifications = props.notifications;
  const preferences = notifications?.preferences ?? null;
  const update = props.desktopUpdate;
  return (
    <>
      {
        <Section label="Deployment">
          <RowGroup>
            {[
              <LinkRow
                accessibilityLabel={`${props.deployment.title}, ${props.deployment.status}. ${props.deployment.action.label}`}
                detail={props.deployment.status}
                key="deployment"
                lead={
                  props.deployment.mark === null ? null : (
                    <DeploymentMarkView mark={props.deployment.mark} />
                  )
                }
                onPress={props.onDeploymentAction}
                title={props.deployment.title}
                trailing={props.deployment.action.label}
              />,
            ]}
          </RowGroup>
        </Section>
      }
      {update === null ? null : (
        <Section label={update.view.title}>
          <RowGroup>{deploymentUpdateRows(update)}</RowGroup>
        </Section>
      )}
      {notifications === null ? null : (
        <Section footer={notifications.footer} label="Notifications">
          <RowGroup>
            {[
              notifications.detail === null ? null : (
                <View key="status" style={styles.row}>
                  <AppText role="secondary" tone="soft">
                    {notifications.detail}
                  </AppText>
                </View>
              ),
              preferences === null ? null : (
                <SwitchRow
                  disabled={notifications.disabled}
                  key="approvals"
                  label="Approvals and questions"
                  onChange={(enabled) => props.onPreferenceChange("approvals", enabled)}
                  value={preferences.approvalsEnabled}
                />
              ),
              preferences === null ? null : (
                <SwitchRow
                  disabled={notifications.disabled}
                  key="outcomes"
                  label="Replies and updates"
                  onChange={(enabled) => props.onPreferenceChange("run-outcomes", enabled)}
                  value={preferences.runOutcomesEnabled}
                />
              ),
              actionRow(notifications.action, props.onNotificationAction, "notification-action"),
            ]}
          </RowGroup>
          <ErrorText detail={props.notificationError} />
        </Section>
      )}
      {quietTasks === null ? null : (
        <Section footer={quietTasksFooter} label="Tasks">
          <RowGroup>
            {[
              <View key="quiet-tasks" style={styles.rowInline}>
                <AppText role="body" style={styles.grow}>
                  {quietTasksTitle}
                </AppText>
                <ChoiceMenu
                  accessibilityLabel={`${quietTasksTitle}: ${quietLabel}. Change`}
                  choices={quietTaskChoices.map((choice) => ({
                    id: String(choice.days),
                    title: choice.label,
                  }))}
                  label={quietLabel}
                  onChoose={(id) => {
                    const choice = quietTaskChoices.find((item) => String(item.days) === id);
                    if (choice !== undefined) quietTasks.onChange(choice.days);
                  }}
                />
              </View>,
            ]}
          </RowGroup>
          <ErrorText detail={quietTasks.error} />
        </Section>
      )}
      {
        <Section label="About">
          <RowGroup>
            {[
              <View key="version" style={styles.rowInline}>
                <AppText role="body">Version</AppText>
                <AppText role="body" tone="muted">
                  {props.version}
                </AppText>
              </View>,
              <LinkRow
                detail="How Opensteer handles your data"
                key="privacy"
                lead={null}
                onPress={() => void Linking.openURL(privacyPolicyUrl)}
                title="Privacy Policy"
              />,
            ]}
          </RowGroup>
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
