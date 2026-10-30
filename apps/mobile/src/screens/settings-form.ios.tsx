import {
  Button,
  Form,
  Host,
  HStack,
  Image,
  Section,
  Spacer,
  Text,
  Toggle,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityHidden,
  accessibilityLabel,
  background,
  disabled,
  font,
  foregroundStyle,
  frame,
  listStyle,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { color, deploymentPaint } from "../theme.js";
import type { DeploymentMark } from "../threads/deployment-switcher-model.js";
import {
  chromeSettingsFooter,
  chromeSettingsRow,
  browserProfilesSettingsRow,
  type SettingsActionModel,
} from "./settings-model.js";
import type { SettingsFormProps } from "./settings-form.types.js";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
const error = foregroundStyle(color.red);
const markSize = 30;

/** One SwiftUI host owns the complete iOS Form, including every row and control. */
export function SettingsForm(props: SettingsFormProps): ReactNode {
  const preferences = props.notifications.preferences;
  return (
    <Host colorScheme="dark" seedColor={color.ember} style={styles.host} useViewportSizeMeasurement>
      <Form modifiers={[listStyle("insetGrouped")]}>
        <Section title="Deployment">
          <IdentityRow
            mark={props.deployment.mark}
            subtitle={props.deployment.status}
            title={props.deployment.title}
          />
          <ActionButton action={props.deployment.action} onPress={props.onDeploymentAction} />
        </Section>

        {props.computers.length === 0 ? null : (
          <Section
            footer={<Text modifiers={[secondary, footnote]}>{props.computersFooter}</Text>}
            title="Computers"
          >
            {props.computers.map((computer) => {
              const row = (
                <HStack alignment="center" spacing={12}>
                  <Image
                    color={color.textSoft}
                    modifiers={[accessibilityHidden(true), frame({ width: 28 })]}
                    size={20}
                    systemName={computer.symbol}
                  />
                  <VStack alignment="leading" spacing={2}>
                    <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
                      {computer.name}
                    </Text>
                    <Text modifiers={[secondary, footnote]}>{computer.detail}</Text>
                  </VStack>
                  <Spacer />
                  {computer.opens === null ? null : (
                    <Image
                      modifiers={[accessibilityHidden(true)]}
                      size={13}
                      systemName="chevron.right"
                      color={color.muted}
                    />
                  )}
                </HStack>
              );
              const opens = computer.opens;
              return opens === null ? (
                <HStack
                  key={computer.key}
                  modifiers={[accessibilityLabel(`${computer.name}, ${computer.detail}`)]}
                >
                  {row}
                </HStack>
              ) : (
                <Button
                  key={computer.key}
                  modifiers={[accessibilityLabel(`${computer.name}, ${computer.detail}`)]}
                  onPress={() => props.onComputerAction(opens)}
                >
                  {row}
                </Button>
              );
            })}
          </Section>
        )}

        {props.onChromeAction === undefined &&
        props.onBrowserProfilesAction === undefined &&
        props.passwords === null ? null : (
          <Section
            footer={<Text modifiers={[secondary, footnote]}>{chromeSettingsFooter}</Text>}
            title="Browser"
          >
            {props.onChromeAction === undefined ? null : (
              <LinkRow
                detail={chromeSettingsRow.detail}
                onPress={props.onChromeAction}
                symbol="globe"
                title={chromeSettingsRow.title}
              />
            )}
            {props.onBrowserProfilesAction === undefined ? null : (
              <LinkRow
                detail={browserProfilesSettingsRow.detail}
                onPress={props.onBrowserProfilesAction}
                symbol="globe"
                title={browserProfilesSettingsRow.title}
              />
            )}
            {props.passwords === null ? null : (
              <LinkRow
                detail={props.passwords.detail}
                onPress={props.onPasswordsAction}
                symbol="lock"
                title={props.passwords.title}
              />
            )}
          </Section>
        )}

        <Section title="Account">
          <IdentityRow
            circular
            initial={props.account.initial}
            subtitle={props.account.subtitle}
            title={props.account.title}
          />
          {props.account.detail === null ? null : (
            <Text modifiers={[secondary, footnote]}>{props.account.detail}</Text>
          )}
          <ActionButton action={props.account.action} onPress={props.onAccountAction} />
          <ErrorText detail={props.accountError} />
        </Section>

        <Section
          footer={<Text modifiers={[secondary, footnote]}>{props.notifications.footer}</Text>}
          title="Notifications"
        >
          <Text modifiers={[secondary, footnote]}>{props.notifications.detail}</Text>
          {preferences === null ? null : (
            <Toggle
              isOn={preferences.approvalsEnabled}
              label="Approvals and questions"
              modifiers={[disabled(props.notifications.disabled)]}
              onIsOnChange={(enabled) => props.onPreferenceChange("approvals", enabled)}
            />
          )}
          {preferences === null ? null : (
            <Toggle
              isOn={preferences.runOutcomesEnabled}
              label="Replies and updates"
              modifiers={[disabled(props.notifications.disabled)]}
              onIsOnChange={(enabled) => props.onPreferenceChange("run-outcomes", enabled)}
            />
          )}
          <ActionButton action={props.notifications.action} onPress={props.onNotificationAction} />
          <ErrorText detail={props.notificationError} />
        </Section>

        {props.agents.length === 0 ? null : (
          <Section
            footer={
              <Text modifiers={[secondary, footnote]}>
                Turning one off silences its own conversations and tasks. Approvals and questions
                still notify you under the setting above, and so does Chat when Opensteer passes
                something on from it. Its work keeps running.
              </Text>
            }
            title="Notifications from specialists"
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

        <Section title="About">
          <Text>Opensteer {props.version}</Text>
          {props.storageError === null ? null : (
            <Text
              modifiers={[
                footnote,
                error,
                accessibilityLabel(`This phone could not save a setting. ${props.storageError}`),
              ]}
            >
              This phone could not save a setting. {props.storageError}
            </Text>
          )}
        </Section>
      </Form>
    </Host>
  );
}

/**
 * A row that names a thing and shows its face: the deployment with its mark,
 * the person with their initial. It is the one place Settings stops being a
 * list of switches and says *whose* phone this is and *where* it is pointed.
 */
function IdentityRow(props: {
  /** An account is a person, and a person's avatar is round. */
  readonly circular?: boolean;
  readonly initial?: string | null;
  readonly mark?: DeploymentMark | null;
  readonly subtitle: string | null;
  readonly title: string;
}): ReactNode {
  const mark = props.mark ?? null;
  const initial = mark?.initial ?? props.initial ?? null;
  const palette = mark === null ? null : deploymentPaint[mark.tone];
  return (
    <HStack alignment="center" spacing={12}>
      {initial === null ? null : (
        <Text
          modifiers={[
            font({ size: 13, weight: "bold" }),
            foregroundStyle(palette?.ink ?? color.textSoft),
            frame({ height: markSize, width: markSize }),
            background(
              palette?.fill ?? color.surfaceRaised,
              props.circular === true
                ? shapes.circle()
                : shapes.roundedRectangle({
                    cornerRadius: 8,
                    roundedCornerStyle: "continuous",
                  }),
            ),
            // The name is on the line beside it, so a mark announced as a
            // letter would be that name's first letter read out twice.
            accessibilityHidden(true),
          ]}
        >
          {initial}
        </Text>
      )}
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ textStyle: "body", weight: "medium" })]}>{props.title}</Text>
        {props.subtitle === null ? null : (
          <Text modifiers={[secondary, footnote]}>{props.subtitle}</Text>
        )}
      </VStack>
    </HStack>
  );
}

/** A row that opens a page or sheet about one thing: its glyph, its name, and a line about it. */
function LinkRow(props: {
  readonly detail: string;
  readonly onPress: () => void;
  readonly symbol: "globe" | "lock";
  readonly title: string;
}): ReactNode {
  return (
    <Button
      modifiers={[accessibilityLabel(`${props.title}, ${props.detail}`)]}
      onPress={props.onPress}
    >
      <HStack alignment="center" spacing={12}>
        <Image
          color={color.textSoft}
          modifiers={[accessibilityHidden(true), frame({ width: 28 })]}
          size={20}
          systemName={props.symbol}
        />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
            {props.title}
          </Text>
          <Text modifiers={[secondary, footnote]}>{props.detail}</Text>
        </VStack>
        <Spacer />
        <Image
          modifiers={[accessibilityHidden(true)]}
          size={13}
          systemName="chevron.right"
          color={color.muted}
        />
      </HStack>
    </Button>
  );
}

function ActionButton(props: {
  readonly action: SettingsActionModel | null;
  readonly onPress: () => void;
}): ReactNode {
  const action = props.action;
  return action === null ? null : (
    <Button
      label={action.label}
      modifiers={[disabled(action.disabled)]}
      onPress={props.onPress}
      role={action.destructive === true ? "destructive" : "default"}
    />
  );
}

function ErrorText(props: { readonly detail: string | null }): ReactNode {
  return props.detail === null ? null : (
    <Text
      modifiers={[
        footnote,
        error,
        accessibilityLabel(`Error: ${props.detail}`),
        accessibilityAddTraits(["isSummaryElement"]),
      ]}
    >
      {props.detail}
    </Text>
  );
}

const styles = StyleSheet.create({ host: { flex: 1 } });
