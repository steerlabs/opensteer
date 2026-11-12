import type { ReactNode } from "react";
import { Linking } from "react-native";
import {
  ActionButton,
  ActionRow,
  ChoiceRow,
  ErrorText,
  LinkRow,
  NoteRow,
  Section,
  ToggleRow,
  ValueRow,
} from "./settings-form-primitives.android.js";
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
  const notifications = props.notifications;
  const preferences = notifications?.preferences ?? null;
  const update = props.desktopUpdate;
  const quietTasks = props.quietTasks ?? null;
  return (
    <>
      <Section title="Deployment">
        <LinkRow
          detail={props.deployment.status}
          onPress={props.onDeploymentAction}
          title={props.deployment.title}
          trailing={props.deployment.action.label}
        />
      </Section>
      {update === null ? null : (
        <Section title={update.view.title}>
          <LinkRow detail={update.view.statusLine} title={update.view.headline} />
          {update.view.versionLine === null ? null : (
            <ValueRow title={update.view.versionLine} value={update.view.channel ?? ""} />
          )}
          {update.view.result === null ? null : update.view.result.tone === "attention" ? (
            <ErrorText detail={update.view.result.text} />
          ) : (
            <NoteRow text={update.view.result.text} />
          )}
          {[update.view.action, update.view.channelAction].map((action) =>
            action === null ? null : (
              <ActionRow
                key={action.label}
                label={action.label}
                onPress={() => update.onAction(action)}
              />
            ),
          )}
        </Section>
      )}
      {notifications === null ? null : (
        <Section footer={notifications.footer} title="Notifications">
          {notifications.detail === null ? null : <NoteRow text={notifications.detail} />}
          {preferences === null ? null : (
            <ToggleRow
              disabled={notifications.disabled}
              onChange={(enabled) => props.onPreferenceChange("approvals", enabled)}
              title="Approvals and questions"
              value={preferences.approvalsEnabled}
            />
          )}
          {preferences === null ? null : (
            <ToggleRow
              disabled={notifications.disabled}
              onChange={(enabled) => props.onPreferenceChange("run-outcomes", enabled)}
              title="Replies and updates"
              value={preferences.runOutcomesEnabled}
            />
          )}
          <ActionButton action={notifications.action} onPress={props.onNotificationAction} />
          <ErrorText detail={props.notificationError} />
        </Section>
      )}
      {quietTasks === null ? null : (
        <Section footer={quietTasksFooter} title="Tasks">
          <ChoiceRow
            choices={quietTaskChoices.map((choice) => ({
              value: String(choice.days),
              label: choice.label,
            }))}
            onChange={(value) => {
              const choice = quietTaskChoices.find((item) => String(item.days) === value);
              if (choice !== undefined) quietTasks.onChange(choice.days);
            }}
            title={quietTasksTitle}
            value={String(quietTasks.days)}
          />
          <ErrorText detail={quietTasks.error} />
        </Section>
      )}
      <Section title="About">
        <ValueRow title="Version" value={props.version} />
        <LinkRow
          detail="How Opensteer handles your data"
          onPress={() => void Linking.openURL(privacyPolicyUrl)}
          title="Privacy Policy"
        />
        <ErrorText
          detail={
            props.storageError === null
              ? null
              : `This phone could not save a setting. ${props.storageError}`
          }
        />
      </Section>
    </>
  );
}
