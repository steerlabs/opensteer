import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { color, radius, space, touchTarget } from "../theme.js";
import { DeploymentMarkView } from "../threads/deployment-mark.js";
import { AppText, RowGroup, SecondaryButton, SectionLabel, SwitchRow } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import {
  browserProfilesSettingsRow,
  chromeSettingsRow,
  computersSettingsFooter,
  connectedAppsSettingsRow,
  specialistNotificationsFooter,
  type SettingsActionModel,
} from "./settings-model.js";
import type { SettingsFormProps } from "./settings-form.types.js";

/**
 * Android and the portable fallback: the same sections as the iOS Form, in
 * grouped rows with the platform Switch.
 */
export function SettingsForm(props: SettingsFormProps): ReactNode {
  const column = useReadingColumn();
  const listInsets = useListContentInsets(space[32]);
  const notifications = props.notifications;
  const preferences = notifications?.preferences ?? null;
  return (
    <Screen edgeToEdge>
      <ScrollView contentContainerStyle={[styles.content, column, listInsets]}>
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

        {props.computers.length === 0 ? null : (
          <Section footer={computersSettingsFooter} label="Computers">
            <RowGroup>
              {props.computers.map((computer) => {
                const opens = computer.opens;
                return (
                  <LinkRow
                    detail={computer.detail}
                    key={computer.key}
                    lead={<Tile symbol={computer.symbol} />}
                    onPress={opens === null ? null : () => props.onComputerAction(opens)}
                    title={computer.name}
                  />
                );
              })}
            </RowGroup>
          </Section>
        )}

        {props.signIns === null ? null : (
          <Section label="Sign-ins">
            <RowGroup>
              {[
                <LinkRow
                  detail={connectedAppsSettingsRow.detail}
                  key="connected-apps"
                  lead={<Tile symbol="puzzlepiece.extension" />}
                  onPress={props.signIns.onConnectedApps}
                  title={connectedAppsSettingsRow.title}
                />,
                <LinkRow
                  detail={chromeSettingsRow.detail}
                  key="chrome"
                  lead={<Tile symbol="globe" />}
                  onPress={props.signIns.onChrome}
                  title={chromeSettingsRow.title}
                />,
                <LinkRow
                  detail={browserProfilesSettingsRow.detail}
                  key="browser-profiles"
                  lead={<Tile symbol="rectangle.on.rectangle" />}
                  onPress={props.signIns.onBrowserProfiles}
                  title={browserProfilesSettingsRow.title}
                />,
                props.passwords === null ? null : (
                  <LinkRow
                    detail={props.passwords.detail}
                    key="passwords"
                    lead={<Tile symbol="key" />}
                    onPress={props.onPasswordsAction}
                    title={props.passwords.title}
                  />
                ),
              ]}
            </RowGroup>
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

        {/* Mutes are kept by the Host, so they don't wait on this phone's registration. */}
        {notifications === null || props.agents.length === 0 ? null : (
          <Section footer={specialistNotificationsFooter} label="Notifications from specialists">
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
          </Section>
        )}

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

        <Section label="About">
          <RowGroup>
            {[
              <View key="version" style={styles.rowInline}>
                <AppText role="body">Version</AppText>
                <AppText role="body" tone="muted">
                  {props.version}
                </AppText>
              </View>,
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
      </ScrollView>
    </Screen>
  );
}

function Section(props: {
  readonly children: ReactNode;
  readonly footer?: string;
  readonly label: string;
}): ReactNode {
  return (
    <View style={styles.section}>
      <SectionLabel>{props.label}</SectionLabel>
      {props.children}
      {props.footer === undefined ? null : (
        <AppText role="caption" tone="muted">
          {props.footer}
        </AppText>
      )}
    </View>
  );
}

/**
 * A row about one thing: its mark, its name and a line under it. With
 * `onPress` it opens that thing, and says so with a chevron.
 */
function LinkRow(props: {
  readonly accessibilityLabel?: string;
  readonly detail: string;
  readonly lead: ReactNode;
  readonly onPress: (() => void) | null;
  readonly title: string;
  /** A word before the chevron naming what the row does. */
  readonly trailing?: string;
}): ReactNode {
  const label = props.accessibilityLabel ?? `${props.title}, ${props.detail}`;
  const body = (
    <>
      {props.lead}
      <View style={[styles.text, styles.grow]}>
        <AppText role="body">{props.title}</AppText>
        <AppText role="secondary" tone="muted">
          {props.detail}
        </AppText>
      </View>
    </>
  );
  if (props.onPress === null) {
    return (
      <View accessible accessibilityLabel={label} style={styles.linkRow}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
    >
      {body}
      {props.trailing === undefined ? null : (
        <AppText role="secondary" tone="muted">
          {props.trailing}
        </AppText>
      )}
      <Symbol name="chevron.right" size={13} tint={color.muted} />
    </Pressable>
  );
}

/** A row's glyph on a quiet tile, so the list is scanned by shape before it is read. */
function Tile(props: { readonly symbol: SFSymbolName }): ReactNode {
  return (
    <View style={styles.tile}>
      <Symbol name={props.symbol} size={16} tint={color.textSoft} />
    </View>
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
  content: { gap: space[24], paddingTop: space[16] },
  grow: { flex: 1 },
  identity: { alignItems: "center", flexDirection: "row", gap: space[12] },
  linkRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[16],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  pressed: { backgroundColor: color.surfacePressed },
  row: { gap: space[8], padding: space[16] },
  rowInline: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: touchTarget + space[8],
    paddingHorizontal: space[16],
  },
  section: { gap: space[8] },
  text: { flexShrink: 1, gap: space[2] },
  tile: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.xs,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
});
