import {
  Button,
  HStack,
  Image,
  ProgressView,
  Section,
  Spacer,
  Text,
  TextField,
  useNativeState,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityLabel,
  autocorrectionDisabled,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import {
  agentAuthorizationFinePrint,
  agentAuthorizationLabelLimit,
  agentAuthorizationUnverified,
  type AgentAuthorizationFormProps,
} from "./agent-authorization-form.types.js";
import { ErrorText, Footer, Lines } from "./settings-form-primitives.ios.js";
import { SettingsPageLayout } from "./settings-page-layout.js";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });

export function AgentAuthorizationForm(props: AgentAuthorizationFormProps): ReactNode {
  return (
    <SettingsPageLayout>
      <Body {...props} />
    </SettingsPageLayout>
  );
}

function Body(props: AgentAuthorizationFormProps): ReactNode {
  if (props.kind === "loading")
    return (
      <Section>
        <HStack>
          <Spacer />
          <ProgressView />
          <Spacer />
        </HStack>
      </Section>
    );
  if (props.kind === "failed")
    return (
      <Section>
        <Lines detail={props.detail} title="Can’t review this request" />
        {props.onRetry === null ? null : <Button label="Try again" onPress={props.onRetry} />}
        <Button label="Close" onPress={props.onClose} />
      </Section>
    );
  const busy = props.busy !== null;
  return (
    <>
      <Section>
        <VStack alignment="leading" spacing={8}>
          <Text
            modifiers={[font({ textStyle: "title2", weight: "bold" }), foregroundStyle(color.text)]}
          >
            {props.title}
          </Text>
          <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(color.textSoft)]}>
            {props.destination}
          </Text>
          <Text modifiers={[secondary, font({ textStyle: "footnote" })]}>
            {agentAuthorizationUnverified}
          </Text>
        </VStack>
      </Section>
      <Section title="What it can do without asking">
        {props.modes.map((option) => (
          <Choice
            key={option.mode}
            detail={option.description}
            disabled={busy}
            selected={option.mode === props.mode}
            title={option.label}
            onPress={() => props.onMode(option.mode)}
          />
        ))}
      </Section>
      <Section title="What it can reach">
        {props.reaches.map((reach) => (
          <Choice
            key={reach.id}
            detail={null}
            disabled={busy}
            selected={reach.id === props.reach}
            title={reach.name}
            onPress={() => props.onReach(reach.id)}
          />
        ))}
      </Section>
      <Section footer={<Footer text={agentAuthorizationFinePrint} />} title="Name">
        <Name busy={busy} label={props.label} onLabel={props.onLabel} />
      </Section>
      <Section>
        <ErrorText detail={props.error} />
        <Button modifiers={[disabled(busy || !props.label.trim())]} onPress={props.onAllow}>
          <HStack modifiers={[contentShape(shapes.rectangle())]}>
            <Text modifiers={[font({ weight: "semibold" })]}>
              {props.busy === "allow" ? "Allowing…" : "Allow"}
            </Text>
            <Spacer />
          </HStack>
        </Button>
        <Button
          label={props.busy === "deny" ? "Denying…" : "Deny"}
          modifiers={[disabled(busy)]}
          onPress={props.onDeny}
          role="destructive"
        />
      </Section>
    </>
  );
}

function Choice(props: {
  readonly detail: string | null;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly selected: boolean;
  readonly title: string;
}): ReactNode {
  return (
    <Button
      modifiers={[
        accessibilityLabel(props.detail === null ? props.title : `${props.title}, ${props.detail}`),
        accessibilityAddTraits(props.selected ? ["isSelected"] : []),
        disabled(props.disabled),
      ]}
      onPress={props.onPress}
    >
      <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
        <Lines detail={props.detail} title={props.title} />
        <Spacer />
        {props.selected ? (
          <Image
            color={color.ember}
            modifiers={[frame({ width: 20 })]}
            size={15}
            systemName="checkmark"
          />
        ) : null}
      </HStack>
    </Button>
  );
}

function Name(props: {
  readonly busy: boolean;
  readonly label: string;
  readonly onLabel: (label: string) => void;
}): ReactNode {
  // Seeded once: the field owns its text, and edits flow back through onLabel.
  const text = useNativeState(props.label);
  return (
    <TextField
      maxLength={agentAuthorizationLabelLimit}
      modifiers={[autocorrectionDisabled(), disabled(props.busy)]}
      placeholder="Connection name"
      text={text}
      onTextChange={props.onLabel}
    />
  );
}
