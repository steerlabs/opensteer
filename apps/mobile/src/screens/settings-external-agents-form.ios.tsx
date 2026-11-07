import { Button, HStack, RNHostView, Section, Spacer, SwipeActions, Text } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import { ExternalAgentMark } from "./external-agent-mark.js";
import { externalAgentsLead } from "@opensteer/client/host";
import { Chevron, ErrorText, Footer, Lines } from "./settings-form-primitives.ios.js";
import type { ExternalAgentsFormProps } from "./settings-external-agents-form.types.js";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });

export function ExternalAgentsForm(props: ExternalAgentsFormProps): ReactNode {
  return (
    <>
      <Section>
        <Text modifiers={[secondary, font({ textStyle: "subheadline" })]}>
          {externalAgentsLead}
        </Text>
      </Section>
      {props.connections.length === 0 ? null : (
        <Section title="Connected">
          {props.connections.map((connection) => (
            <SwipeActions key={connection.id}>
              <Button
                modifiers={[
                  accessibilityLabel(`${connection.title}, ${connection.detail}`),
                  disabled(props.removeDisabled),
                ]}
                onPress={() => props.onRemove(connection.id)}
              >
                <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]}>
                  <Lines
                    detail={connection.removing ? "Removing…" : connection.detail}
                    title={connection.title}
                  />
                  <Spacer />
                  <Text
                    modifiers={[foregroundStyle(color.red), font({ textStyle: "subheadline" })]}
                  >
                    Remove
                  </Text>
                </HStack>
              </Button>
              <SwipeActions.Actions allowsFullSwipe={false}>
                <Button
                  label="Remove"
                  modifiers={[disabled(props.removeDisabled)]}
                  role="destructive"
                  onPress={() => props.onRemove(connection.id)}
                />
              </SwipeActions.Actions>
            </SwipeActions>
          ))}
        </Section>
      )}
      {props.notice === null ? null : (
        <Section>
          <Lines detail={props.notice.detail} title={props.notice.title} />
          {props.notice.action === null ? null : (
            <Button label={props.notice.action.label} onPress={props.notice.action.onPress} />
          )}
        </Section>
      )}
      <Section
        title="Add an agent"
        {...(props.footnote === null ? {} : { footer: <Footer text={props.footnote} /> })}
      >
        {props.guides.map((guide) => (
          <Button
            key={guide.id}
            modifiers={[
              accessibilityLabel(`Add ${guide.name}, ${guide.summary}`),
              disabled(props.addDisabled),
            ]}
            onPress={() => props.onAdd(guide)}
          >
            <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
              <RNHostView matchContents>
                <ExternalAgentMark providerId={guide.providerId} />
              </RNHostView>
              <Lines detail={guide.summary} title={guide.name} />
              <Spacer />
              <Chevron />
            </HStack>
          </Button>
        ))}
      </Section>
      {props.error === null ? null : (
        <Section>
          <ErrorText detail={props.error} />
        </Section>
      )}
    </>
  );
}
