import {
  Button,
  Form,
  Host,
  HStack,
  Image,
  LabeledContent,
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
  contentShape,
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
import type { DeploymentMark } from "../threads/deployment-identity.js";
import {
  browserProfilesSettingsRow,
  chromeSettingsRow,
  computersSettingsFooter,
  connectedAppsSettingsRow,
  specialistNotificationsFooter,
  type SettingsActionModel,
} from "./settings-model.js";
import type { SFSymbolName } from "../ui/symbol.js";
import type { SettingsFormProps } from "./settings-form.types.js";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
const error = foregroundStyle(color.red);
const markSize = 30;
const tileShape = shapes.roundedRectangle({ cornerRadius: 7, roundedCornerStyle: "continuous" });

/**
 * One SwiftUI host owns the complete iOS Form, including every row and control.
 * Sections run from where this phone is pointed, through what agents can
 * reach, to this phone's own notifications and account.
 */
export function SettingsForm(props: SettingsFormProps): ReactNode {
  const notifications = props.notifications;
  const preferences = notifications?.preferences ?? null;
  return (
    <Host colorScheme="dark" seedColor={color.ember} style={styles.host} useViewportSizeMeasurement>
      <Form modifiers={[listStyle("insetGrouped")]}>
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

        {props.computers.length === 0 ? null : (
          <Section footer={<Footer text={computersSettingsFooter} />} title="Computers">
            {props.computers.map((computer) => {
              const opens = computer.opens;
              const label = accessibilityLabel(`${computer.name}, ${computer.detail}`);
              const row = (
                <HStack
                  alignment="center"
                  modifiers={[contentShape(shapes.rectangle())]}
                  spacing={12}
                >
                  <Tile symbol={computer.symbol} />
                  <Lines detail={computer.detail} title={computer.name} />
                  <Spacer />
                  {opens === null ? null : <Chevron />}
                </HStack>
              );
              return opens === null ? (
                <HStack key={computer.key} modifiers={[label]}>
                  {row}
                </HStack>
              ) : (
                <Button
                  key={computer.key}
                  modifiers={[label]}
                  onPress={() => props.onComputerAction(opens)}
                >
                  {row}
                </Button>
              );
            })}
          </Section>
        )}

        {props.signIns === null ? null : (
          <Section title="Sign-ins">
            <LinkRow
              detail={connectedAppsSettingsRow.detail}
              onPress={props.signIns.onConnectedApps}
              symbol="puzzlepiece.extension"
              title={connectedAppsSettingsRow.title}
            />
            <LinkRow
              detail={chromeSettingsRow.detail}
              onPress={props.signIns.onChrome}
              symbol="globe"
              title={chromeSettingsRow.title}
            />
            <LinkRow
              detail={browserProfilesSettingsRow.detail}
              onPress={props.signIns.onBrowserProfiles}
              symbol="rectangle.on.rectangle"
              title={browserProfilesSettingsRow.title}
            />
            {props.passwords === null ? null : (
              <LinkRow
                detail={props.passwords.detail}
                onPress={props.onPasswordsAction}
                symbol="key"
                title={props.passwords.title}
              />
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

        {/* Mutes are kept by the Host, so they don't wait on this phone's registration. */}
        {notifications === null || props.agents.length === 0 ? null : (
          <Section
            footer={<Footer text={specialistNotificationsFooter} />}
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
      </Form>
    </Host>
  );
}

/** A name and the line under it, the shape every row in Settings shares. */
function Lines(props: { readonly detail: string | null; readonly title: string }): ReactNode {
  return (
    <VStack alignment="leading" spacing={2}>
      <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
        {props.title}
      </Text>
      {props.detail === null ? null : <Text modifiers={[secondary, footnote]}>{props.detail}</Text>}
    </VStack>
  );
}

/** A row's glyph on a quiet tile, so the list is scanned by shape before it is read. */
function Tile(props: { readonly symbol: SFSymbolName }): ReactNode {
  return (
    <Image
      color={color.textSoft}
      modifiers={[
        accessibilityHidden(true),
        frame({ height: markSize, width: markSize }),
        background(color.surfaceRaised, tileShape),
      ]}
      size={15}
      systemName={props.symbol}
    />
  );
}

/**
 * Whose phone this is and where it is pointed, as a face: the deployment's
 * coloured mark, the person's round initial.
 */
function IdentityMark(props: {
  /** An account is a person, and a person's avatar is round. */
  readonly circular?: boolean;
  readonly initial?: string | null;
  readonly mark?: DeploymentMark | null;
}): ReactNode {
  const mark = props.mark ?? null;
  const initial = mark?.initial ?? props.initial ?? null;
  if (initial === null) return null;
  const palette = mark === null ? null : deploymentPaint[mark.tone];
  return (
    <Text
      modifiers={[
        font({ size: 13, weight: "bold" }),
        foregroundStyle(palette?.ink ?? color.textSoft),
        frame({ height: markSize, width: markSize }),
        background(
          palette?.fill ?? color.surfaceRaised,
          props.circular === true ? shapes.circle() : tileShape,
        ),
        // The name is on the line beside it, so a mark announced as a
        // letter would be that name's first letter read out twice.
        accessibilityHidden(true),
      ]}
    >
      {initial}
    </Text>
  );
}

/** A row that opens a page or sheet about one thing. */
function LinkRow(props: {
  readonly detail: string;
  readonly onPress: () => void;
  readonly symbol: SFSymbolName;
  readonly title: string;
}): ReactNode {
  return (
    <Button
      modifiers={[accessibilityLabel(`${props.title}, ${props.detail}`)]}
      onPress={props.onPress}
    >
      <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
        <Tile symbol={props.symbol} />
        <Lines detail={props.detail} title={props.title} />
        <Spacer />
        <Chevron />
      </HStack>
    </Button>
  );
}

function Chevron(): ReactNode {
  return (
    <Image
      color={color.muted}
      modifiers={[accessibilityHidden(true)]}
      size={13}
      systemName="chevron.right"
    />
  );
}

function Footer(props: { readonly text: string }): ReactNode {
  return <Text modifiers={[secondary, footnote]}>{props.text}</Text>;
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
