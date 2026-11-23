import {
  Box,
  CircularProgressIndicator,
  ListItem,
  RadioButton,
  RNHostView,
  Text,
  TextButton,
} from "@expo/ui/jetpack-compose";
import { fillMaxWidth, padding, selectable } from "@expo/ui/jetpack-compose/modifiers";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import {
  agentAuthorizationLabelLimit,
  type AgentAuthorizationFormProps,
} from "./agent-authorization-form.types.js";
import { agentWords } from "@opensteer/client/host";
import { ExternalAgentMark } from "./external-agent-mark.js";
import { NativeSettingsSections } from "./native-settings-page.android.js";
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
        <LinkRow detail={props.detail} title={props.title} />
        {props.onRetry === null ? null : <ActionRow label="Try again" onPress={props.onRetry} />}
        <ActionRow label="Close" onPress={props.onClose} />
      </Section>
    );
  const busy = props.busy !== null;
  return (
    <>
      {props.mark === null ? null : (
        <Box modifiers={[padding(16, 8, 16, 0)]}>
          <RNHostView matchContents>
            <ExternalAgentMark
              initial={props.mark.initial}
              providerId={props.mark.providerId}
              size={56}
            />
          </RNHostView>
        </Box>
      )}
      <Text
        color={color.text}
        modifiers={[padding(16, 8, 16, 4)]}
        style={{ typography: "headlineSmall" }}
      >
        {props.title}
      </Text>
      <Text
        color={color.textSoft}
        modifiers={[padding(16, 8, 16, 8)]}
        maxLines={1}
        style={{ typography: "bodyMedium" }}
      >
        {props.who.verified ? `✓ ${props.who.heading}` : props.who.heading}
      </Text>
      {props.who.origins.map((line) => (
        <NoteRow key={line} text={line} />
      ))}
      {props.destination === null ? null : <NoteRow text={props.destination} />}
      {props.who.warning === null ? null : (
        <Text
          color={color.text}
          modifiers={[padding(16, 0, 16, 8)]}
          style={{ typography: "bodySmall" }}
        >
          {props.who.warning}
        </Text>
      )}
      {props.sections === null ? (
        <>
          <Section title="What it can do without asking">
            {props.modes.map((option) => {
              const selected = option.mode === props.mode;
              return (
                <ListItem
                  colors={{ containerColor: "#00000000" }}
                  key={option.mode}
                  modifiers={
                    busy
                      ? []
                      : [selectable(selected, () => props.onMode(option.mode), "radioButton")]
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
        </>
      ) : (
        <NativeSettingsSections sections={props.sections} />
      )}
      <Section footer={props.finePrint} title={agentWords("consent.name.title")}>
        <InputRow
          label={agentWords("consent.name.placeholder")}
          maxLength={agentAuthorizationLabelLimit}
          onChange={props.onLabel}
          value={props.label}
          disabled={busy}
        />
      </Section>
      {props.notice === null ? null : (
        <Text
          color={color.amber}
          modifiers={[padding(16, 8, 16, 0)]}
          style={{ typography: "bodySmall" }}
        >
          {props.notice}
        </Text>
      )}
      <ErrorText detail={props.error} />
      <PrimaryButton
        disabled={busy || !props.label.trim()}
        label={
          props.busy === "allow" ? agentWords("consent.allowing") : agentWords("consent.allow")
        }
        onPress={props.onAllow}
      />
      <Box contentAlignment="center" modifiers={[fillMaxWidth()]}>
        <TextButton enabled={!busy} onClick={props.onDeny}>
          <Text color={busy ? color.mutedDim : color.red}>
            {props.busy === "deny" ? agentWords("consent.denying") : agentWords("consent.deny")}
          </Text>
        </TextButton>
      </Box>
    </>
  );
}
