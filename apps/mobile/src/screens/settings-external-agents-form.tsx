import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { color } from "../theme.js";
import { AppText, Notice, RowGroup } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { ExternalAgentMark } from "./external-agent-mark.js";
import { externalAgentsLead } from "./external-agents-model.js";
import { ErrorText, Section, styles } from "./settings-form-primitives.js";
import type { ExternalAgentsFormProps } from "./settings-external-agents-form.types.js";

export function ExternalAgentsForm(props: ExternalAgentsFormProps): ReactNode {
  const addDisabled = props.notice !== null;
  return (
    <>
      <AppText role="secondary" tone="soft">
        {externalAgentsLead}
      </AppText>
      {props.connections.length === 0 ? null : (
        <Section label="Connected">
          <RowGroup>
            {props.connections.map((connection) => (
              <View key={connection.id} style={styles.linkRow}>
                <View style={[styles.text, styles.grow]}>
                  <AppText role="body">{connection.title}</AppText>
                  <AppText role="secondary" tone="muted">
                    {connection.removing ? "Removing…" : connection.detail}
                  </AppText>
                </View>
                <Pressable
                  accessibilityLabel={`Remove ${connection.title}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: connection.removing }}
                  disabled={connection.removing}
                  hitSlop={12}
                  onPress={() => props.onRemove(connection.id)}
                >
                  <AppText role="secondaryMedium" tone="danger">
                    Remove
                  </AppText>
                </Pressable>
              </View>
            ))}
          </RowGroup>
        </Section>
      )}
      {props.notice === null ? null : (
        <Notice
          detail={props.notice.detail}
          title={props.notice.title}
          tone="neutral"
          {...(props.notice.action === null ? {} : { action: props.notice.action })}
        />
      )}
      <Section
        label="Add an agent"
        {...(props.footnote === null ? {} : { footer: props.footnote })}
      >
        <RowGroup>
          {props.guides.map((guide) => (
            <Pressable
              key={guide.id}
              accessibilityLabel={`Add ${guide.name}, ${guide.summary}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: addDisabled }}
              disabled={addDisabled}
              onPress={() => props.onAdd(guide)}
              style={({ pressed }) => [
                styles.linkRow,
                pressed && styles.pressed,
                addDisabled && { opacity: 0.45 },
              ]}
            >
              <ExternalAgentMark providerId={guide.providerId} />
              <View style={[styles.text, styles.grow]}>
                <AppText role="body">{guide.name}</AppText>
                <AppText role="secondary" tone="muted">
                  {guide.summary}
                </AppText>
              </View>
              <Symbol name="chevron.right" size={13} tint={color.muted} />
            </Pressable>
          ))}
        </RowGroup>
      </Section>
      <ErrorText detail={props.error} />
    </>
  );
}
