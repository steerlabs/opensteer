import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import {
  AppText,
  Field,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
} from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import {
  agentAuthorizationFinePrint,
  agentAuthorizationLabelLimit,
  agentAuthorizationUnverified,
  type AgentAuthorizationFormProps,
} from "./agent-authorization-form.types.js";
import { ErrorText, Section } from "./settings-form-primitives.js";

export function AgentAuthorizationForm(props: AgentAuthorizationFormProps): ReactNode {
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <Body {...props} />
      </ScrollView>
    </Screen>
  );
}

function Body(props: AgentAuthorizationFormProps): ReactNode {
  if (props.kind === "loading")
    return <ActivityIndicator color={color.muted} style={styles.wait} />;
  if (props.kind === "failed")
    return (
      <>
        <Notice
          detail={props.detail}
          title="Can’t review this request"
          {...(props.onRetry === null
            ? {}
            : { action: { label: "Try again", onPress: props.onRetry } })}
        />
        <SecondaryButton label="Close" onPress={props.onClose} />
      </>
    );
  const busy = props.busy !== null;
  return (
    <>
      <View style={styles.head}>
        <AppText role="displaySmall">{props.title}</AppText>
        <AppText role="secondary" tone="soft">
          {props.destination}
        </AppText>
        <AppText role="secondary" tone="muted">
          {agentAuthorizationUnverified}
        </AppText>
      </View>
      <Section label="What it can do without asking">
        <RowGroup>
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
        </RowGroup>
      </Section>
      <Section label="What it can reach">
        <RowGroup>
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
        </RowGroup>
      </Section>
      <Field
        hint={agentAuthorizationFinePrint}
        input={{
          autoCorrect: false,
          editable: !busy,
          maxLength: agentAuthorizationLabelLimit,
          onChangeText: props.onLabel,
          value: props.label,
        }}
        label="Name"
      />
      <ErrorText detail={props.error} />
      <View style={styles.actions}>
        <PrimaryButton
          busy={props.busy === "allow"}
          disabled={busy || !props.label.trim()}
          label="Allow"
          onPress={props.onAllow}
        />
        <SecondaryButton
          busy={props.busy === "deny"}
          disabled={busy}
          label="Deny"
          onPress={props.onDeny}
        />
      </View>
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
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [styles.choice, pressed && styles.pressed]}
    >
      <View style={styles.choiceText}>
        <AppText role="body">{props.title}</AppText>
        {props.detail === null ? null : (
          <AppText role="secondary" tone="muted">
            {props.detail}
          </AppText>
        )}
      </View>
      {props.selected ? <Symbol name="checkmark" size={15} tint={color.ember} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { gap: space[10] },
  choice: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 52,
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  choiceText: { flex: 1, gap: space[2] },
  content: { gap: space[24], padding: space[16] },
  head: { gap: space[8] },
  pressed: { backgroundColor: color.surfacePressed },
  wait: { marginTop: space[48] },
});
