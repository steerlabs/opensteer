import {
  Box,
  CircularProgressIndicator,
  ListItem,
  RadioButton,
  Text,
  TextButton,
} from "@expo/ui/jetpack-compose";
import { fillMaxWidth, padding, selectable } from "@expo/ui/jetpack-compose/modifiers";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import {
  agentAuthorizationFinePrint,
  agentAuthorizationLabelLimit,
  agentAuthorizationUnverified,
  type AgentAuthorizationFormProps,
} from "./agent-authorization-form.types.js";
import {
  ActionRow,
  ErrorText,
  InputRow,
  LinkRow,
  NoteRow,
  PrimaryButton,
  Section,
} from "./settings-form-primitives.android.js";
import { SettingsPageLayout } from "./settings-page-layout.android.js";

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
      <Box contentAlignment="center" modifiers={[fillMaxWidth(), padding(0, 48, 0, 0)]}>
        <CircularProgressIndicator color={color.muted} />
      </Box>
    );
  if (props.kind === "failed")
    return (
      <Section>
        <LinkRow detail={props.detail} title="Can’t review this request" />
        {props.onRetry === null ? null : <ActionRow label="Try again" onPress={props.onRetry} />}
        <ActionRow label="Close" onPress={props.onClose} />
      </Section>
    );
  const busy = props.busy !== null;
  return (
    <>
      <Text
        color={color.text}
        modifiers={[padding(16, 8, 16, 4)]}
        style={{ typography: "headlineSmall" }}
      >
        {props.title}
      </Text>
      <NoteRow text={props.destination} />
      <Text
        color={color.muted}
        modifiers={[padding(16, 0, 16, 8)]}
        style={{ typography: "bodySmall" }}
      >
        {agentAuthorizationUnverified}
      </Text>
      <Section title="What it can do without asking">
        {props.modes.map((option) => {
          const selected = option.mode === props.mode;
          return (
            <ListItem
              colors={{ containerColor: "#00000000" }}
              key={option.mode}
              modifiers={
                busy ? [] : [selectable(selected, () => props.onMode(option.mode), "radioButton")]
              }
            >
              <ListItem.LeadingContent>
                <RadioButton enabled={!busy} selected={selected} />
              </ListItem.LeadingContent>
              <ListItem.HeadlineContent>
                <Text color={color.text}>{option.label}</Text>
              </ListItem.HeadlineContent>
              {option.description === null ? null : (
                <ListItem.SupportingContent>
                  <Text color={color.muted}>{option.description}</Text>
                </ListItem.SupportingContent>
              )}
            </ListItem>
          );
        })}
      </Section>
      <Section footer={agentAuthorizationFinePrint} title="Name">
        <InputRow
          label="Connection name"
          maxLength={agentAuthorizationLabelLimit}
          onChange={props.onLabel}
          value={props.label}
          disabled={busy}
        />
      </Section>
      <ErrorText detail={props.error} />
      <PrimaryButton
        disabled={busy || !props.label.trim()}
        label={props.busy === "allow" ? "Allowing…" : "Allow"}
        onPress={props.onAllow}
      />
      <Box contentAlignment="center" modifiers={[fillMaxWidth()]}>
        <TextButton enabled={!busy} onClick={props.onDeny}>
          <Text color={busy ? color.mutedDim : color.red}>
            {props.busy === "deny" ? "Denying…" : "Deny"}
          </Text>
        </TextButton>
      </Box>
    </>
  );
}
