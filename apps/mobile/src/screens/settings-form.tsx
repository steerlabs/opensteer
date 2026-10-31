import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { color, radius, space, touchTarget } from "../theme.js";
import { DeploymentMarkView } from "../threads/deployment-mark.js";
import { AppText, RowGroup, SecondaryButton, SectionLabel, SwitchRow } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import {
  chromeSettingsFooter,
  chromeSettingsRow,
  browserProfilesSettingsRow,
  connectedAppsSettingsRow,
  type SettingsActionModel,
} from "./settings-model.js";
import type { SettingsFormProps } from "./settings-form.types.js";

/** Android and the portable fallback use the platform Switch inside native grouped rows. */
export function SettingsForm(props: SettingsFormProps): ReactNode {
  const column = useReadingColumn();
  const listInsets = useListContentInsets(space[32]);
  const preferences = props.notifications.preferences;
  return (
    <Screen edgeToEdge>
      <ScrollView contentContainerStyle={[styles.content, column, listInsets]}>
        <View style={styles.section}>
          <SectionLabel>Deployment</SectionLabel>
          <RowGroup>
            {[
              <View key="current-deployment" style={styles.identityRow}>
                {props.deployment.mark === null ? null : (
                  <DeploymentMarkView mark={props.deployment.mark} />
                )}
                <View style={styles.identityText}>
                  <AppText role="bodyMedium">{props.deployment.title}</AppText>
                  <AppText role="secondary" tone="soft">
                    {props.deployment.status}
                  </AppText>
                </View>
              </View>,
              actionRow(props.deployment.action, props.onDeploymentAction, "deployment-action"),
            ]}
          </RowGroup>
        </View>

        {props.computers.length === 0 ? null : (
          <View style={styles.section}>
            <SectionLabel>Computers</SectionLabel>
            <RowGroup>
              {props.computers.map((computer) => {
                const opens = computer.opens;
                const body = (
                  <>
                    <Symbol name={computer.symbol} size={20} tint={color.textSoft} />
                    <View style={[styles.identityText, styles.computerText]}>
                      <AppText role="bodyMedium">{computer.name}</AppText>
                      <AppText role="secondary" tone="soft">
                        {computer.detail}
                      </AppText>
                    </View>
                  </>
                );
                return opens === null ? (
                  <View
                    accessibilityLabel={`${computer.name}, ${computer.detail}`}
                    key={computer.key}
                    style={styles.linkRow}
                  >
                    {body}
                  </View>
                ) : (
                  <Pressable
                    accessibilityLabel={`${computer.name}, ${computer.detail}`}
                    accessibilityRole="button"
                    key={computer.key}
                    onPress={() => props.onComputerAction(opens)}
                    style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
                  >
                    {body}
                    <Symbol name="chevron.right" size={13} tint={color.muted} />
                  </Pressable>
                );
              })}
            </RowGroup>
            <AppText role="caption" tone="muted">
              {props.computersFooter}
            </AppText>
          </View>
        )}

        {props.onConnectedAppsAction === undefined ? null : (
          <View style={styles.section}>
            <SectionLabel>Apps</SectionLabel>
            <RowGroup>
              {[
                <Pressable
                  accessibilityLabel={`${connectedAppsSettingsRow.title}, ${connectedAppsSettingsRow.detail}`}
                  accessibilityRole="button"
                  key="connected-apps"
                  onPress={props.onConnectedAppsAction}
                  style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
                >
                  <Symbol name="puzzlepiece.extension" size={20} tint={color.textSoft} />
                  <View style={[styles.identityText, styles.computerText]}>
                    <AppText role="bodyMedium">{connectedAppsSettingsRow.title}</AppText>
                    <AppText role="secondary" tone="soft">
                      {connectedAppsSettingsRow.detail}
                    </AppText>
                  </View>
                  <Symbol name="chevron.right" size={13} tint={color.muted} />
                </Pressable>,
              ]}
            </RowGroup>
          </View>
        )}

        {props.onChromeAction === undefined &&
        props.onBrowserProfilesAction === undefined &&
        props.passwords === null ? null : (
          <View style={styles.section}>
            <SectionLabel>Browser</SectionLabel>
            <RowGroup>
              {[
                props.onChromeAction === undefined ? null : (
                  <Pressable
                    accessibilityLabel={`${chromeSettingsRow.title}, ${chromeSettingsRow.detail}`}
                    accessibilityRole="button"
                    key="chrome"
                    onPress={props.onChromeAction}
                    style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
                  >
                    <Symbol name="globe" size={20} tint={color.textSoft} />
                    <View style={[styles.identityText, styles.computerText]}>
                      <AppText role="bodyMedium">{chromeSettingsRow.title}</AppText>
                      <AppText role="secondary" tone="soft">
                        {chromeSettingsRow.detail}
                      </AppText>
                    </View>
                    <Symbol name="chevron.right" size={13} tint={color.muted} />
                  </Pressable>
                ),
                props.onBrowserProfilesAction === undefined ? null : (
                  <Pressable
                    accessibilityLabel={`${browserProfilesSettingsRow.title}, ${browserProfilesSettingsRow.detail}`}
                    accessibilityRole="button"
                    key="browser-profiles"
                    onPress={props.onBrowserProfilesAction}
                    style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
                  >
                    <Symbol name="globe" size={20} tint={color.textSoft} />
                    <View style={[styles.identityText, styles.computerText]}>
                      <AppText role="bodyMedium">{browserProfilesSettingsRow.title}</AppText>
                      <AppText role="secondary" tone="soft">
                        {browserProfilesSettingsRow.detail}
                      </AppText>
                    </View>
                    <Symbol name="chevron.right" size={13} tint={color.muted} />
                  </Pressable>
                ),
                props.passwords === null ? null : (
                  <Pressable
                    accessibilityLabel={`${props.passwords.title}, ${props.passwords.detail}`}
                    accessibilityRole="button"
                    key="passwords"
                    onPress={props.onPasswordsAction}
                    style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
                  >
                    <Symbol name="lock" size={20} tint={color.textSoft} />
                    <View style={[styles.identityText, styles.computerText]}>
                      <AppText role="bodyMedium">{props.passwords.title}</AppText>
                      <AppText role="secondary" tone="soft">
                        {props.passwords.detail}
                      </AppText>
                    </View>
                    <Symbol name="chevron.right" size={13} tint={color.muted} />
                  </Pressable>
                ),
              ]}
            </RowGroup>
            <AppText role="caption" tone="muted">
              {chromeSettingsFooter}
            </AppText>
          </View>
        )}

        <View style={styles.section}>
          <SectionLabel>Account</SectionLabel>
          <RowGroup>
            {[
              <View key="identity" style={styles.row}>
                <View style={styles.identity}>
                  {props.account.initial === null ? null : (
                    <AvatarInitial initial={props.account.initial} />
                  )}
                  <View style={styles.identityText}>
                    <AppText role="bodyMedium">{props.account.title}</AppText>
                    {props.account.subtitle === null ? null : (
                      <AppText role="caption" tone="muted">
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
        </View>

        <View style={styles.section}>
          <SectionLabel>Notifications</SectionLabel>
          <RowGroup>
            {[
              <View key="status" style={styles.row}>
                <AppText role="secondary" tone="soft">
                  {props.notifications.detail}
                </AppText>
              </View>,
              preferences === null ? null : (
                <SwitchRow
                  disabled={props.notifications.disabled}
                  key="approvals"
                  label="Approvals and questions"
                  onChange={(enabled) => props.onPreferenceChange("approvals", enabled)}
                  value={preferences.approvalsEnabled}
                />
              ),
              preferences === null ? null : (
                <SwitchRow
                  disabled={props.notifications.disabled}
                  key="outcomes"
                  label="Replies and updates"
                  onChange={(enabled) => props.onPreferenceChange("run-outcomes", enabled)}
                  value={preferences.runOutcomesEnabled}
                />
              ),
              actionRow(
                props.notifications.action,
                props.onNotificationAction,
                "notification-action",
              ),
            ]}
          </RowGroup>
          <AppText role="caption" tone="muted">
            {props.notifications.footer}
          </AppText>
          <ErrorText detail={props.notificationError} />
        </View>

        {props.agents.length === 0 ? null : (
          <View style={styles.section}>
            <SectionLabel>Notifications from specialists</SectionLabel>
            <RowGroup>
              {props.agents.map((agent) => (
                <SwitchRow
                  key={agent.workspaceId}
                  label={agent.name}
                  onChange={(enabled) => props.onAgentMuteChange(agent.workspaceId, !enabled)}
                  value={!agent.muted}
                />
              ))}
            </RowGroup>
            <AppText role="caption" tone="muted">
              Turning one off silences its own conversations and tasks. Approvals and questions
              still notify you under the setting above, and so does Chat when Opensteer passes
              something on from it. Its work keeps running.
            </AppText>
          </View>
        )}

        <View style={styles.section}>
          <SectionLabel>About</SectionLabel>
          <RowGroup>
            {[
              <View key="version" style={styles.rowInline}>
                <AppText role="body">Opensteer</AppText>
                <AppText role="body" tone="muted">
                  {props.version}
                </AppText>
              </View>,
            ]}
          </RowGroup>
          {props.storageError === null ? null : (
            <View accessibilityLiveRegion="polite" accessibilityRole="alert">
              <AppText role="secondary" tone="danger">
                This phone could not save a setting. {props.storageError}
              </AppText>
            </View>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

function actionRow(
  action: SettingsActionModel | null,
  onPress: () => void,
  key: string,
): ReactNode {
  return action === null ? null : (
    <View key={key} style={styles.actionRow}>
      <SecondaryButton
        disabled={action.disabled}
        label={action.label}
        onPress={onPress}
        tone={action.destructive === true ? "danger" : "default"}
      />
    </View>
  );
}

/**
 * The person, as one letter. It is neutral rather than tinted: a deployment's
 * mark carries a colour because there are several of them to tell apart, and
 * there is only ever one person signed in here.
 */
function AvatarInitial(props: { readonly initial: string }): ReactNode {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.avatar}
    >
      <Text allowFontScaling={false} style={styles.avatarInitial}>
        {props.initial}
      </Text>
    </View>
  );
}

function ErrorText(props: { readonly detail: string | null }): ReactNode {
  return props.detail === null ? null : (
    <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
      <AppText role="secondary" tone="danger">
        {props.detail}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  actionRow: { alignItems: "flex-start", padding: space[16] },
  avatar: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  avatarInitial: { color: color.textSoft, fontSize: 13, fontWeight: "700" },
  content: {
    gap: space[24],
    paddingTop: space[16],
  },
  identity: { alignItems: "center", flexDirection: "row", gap: space[12] },
  identityRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    padding: space[16],
  },
  computerText: { flex: 1 },
  identityText: { flexShrink: 1, gap: space[2] },
  linkRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    justifyContent: "space-between",
    minHeight: touchTarget + space[16],
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  pressed: { backgroundColor: color.surfacePressed },
  row: { gap: space[4], padding: space[16] },
  rowInline: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 52,
    paddingHorizontal: space[16],
  },
  section: { gap: space[8] },
});
