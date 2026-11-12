import { RNHostView, TextButton, Text } from "@expo/ui/jetpack-compose";
import { semantics } from "@expo/ui/jetpack-compose/modifiers";
import { externalAgentsLead } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import { ExternalAgentMark } from "./external-agent-mark.js";
import {
  ActionRow,
  ErrorText,
  LinkRow,
  NoteRow,
  Section,
} from "./settings-form-primitives.android.js";
import type { ExternalAgentsFormProps } from "./settings-external-agents-form.types.js";

export function ExternalAgentsForm(props: ExternalAgentsFormProps): ReactNode {
  return (
    <>
      <NoteRow text={externalAgentsLead} />
      {props.connections.length === 0 ? null : (
        <Section title="Connected">
          {props.connections.map((connection) => (
            <LinkRow
              detail={connection.removing ? "Removing…" : connection.detail}
              key={connection.id}
              title={connection.title}
              trailing={
                <TextButton
                  enabled={!props.removeDisabled}
                  onClick={() => props.onRemove(connection.id)}
                  modifiers={[semantics({ contentDescription: `Remove ${connection.title}` })]}
                >
                  <Text color={props.removeDisabled ? color.mutedDim : color.red}>Remove</Text>
                </TextButton>
              }
            />
          ))}
        </Section>
      )}
      {props.notice === null ? null : (
        <Section>
          <LinkRow detail={props.notice.detail} title={props.notice.title} />
          {props.notice.action === null ? null : (
            <ActionRow label={props.notice.action.label} onPress={props.notice.action.onPress} />
          )}
        </Section>
      )}
      <Section footer={props.footnote ?? undefined} title="Add an agent">
        {props.guides.map((guide) => (
          <LinkRow
            detail={guide.summary}
            disabled={props.addDisabled}
            key={guide.id}
            lead={
              <RNHostView matchContents>
                <ExternalAgentMark providerId={guide.providerId} />
              </RNHostView>
            }
            onPress={() => props.onAdd(guide)}
            title={guide.name}
          />
        ))}
      </Section>
      <ErrorText detail={props.error} />
    </>
  );
}
