import type { HostClient } from "@opensteer/client/host";
import {
  pluginAuthorText,
  pluginConsentLines,
  pluginInputContent,
  pluginRequestResponses,
  pluginRequestView,
  type PluginInputField,
} from "@opensteer/client/plugins";
import type { Request } from "@opensteer/core";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { color, controlFontScaleLimit, radius, space, touchTarget, type } from "../theme.js";
import { AppText, monoFontFamily, SwitchRow } from "../ui/primitives.js";
import { AnswerPill, AnswerRow } from "./answer-pill.js";
import type { RequestResponder } from "./use-request-response.js";

/**
 * `plugin.account`, `plugin.approval` and `plugin.input` in the Request sheet,
 * the same decisions as on a computer. An account is answered by linking one;
 * an approval shows the exact arguments the call runs with; a form's values go
 * to the plugin, never to the agent, and closing the sheet drops them.
 */
export function PluginRequestBody(props: {
  readonly canRespond: boolean;
  readonly hostClient: HostClient;
  readonly reason: string | null;
  readonly request: Request;
  readonly responder: RequestResponder;
}): ReactNode {
  const navigation = useNavigation();
  const { request, responder } = props;
  const { session } = responder;
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const view = pluginRequestView(request);
  if (!view)
    return (
      <AppText role="secondary" tone="muted">
        This needs a newer Opensteer to answer.
      </AppText>
    );
  const locked = !props.canRespond || session.pendingId !== null;
  const status =
    props.reason !== null || session.failure !== null ? (
      <AppText role="caption" tone={session.failure === null ? "muted" : "danger"}>
        {session.failure ?? props.reason}
      </AppText>
    ) : null;
  const who = (
    <AppText role="caption" tone="muted">
      {view.plugin.name} · {pluginAuthorText(view.plugin.author)}
    </AppText>
  );
  if (view.kind === "account") {
    const deploymentId = props.hostClient.getSnapshot().deploymentId;
    return (
      <View style={styles.section}>
        {who}
        {pluginConsentLines({
          consent: view.consent,
          author: view.plugin.author,
          pluginName: view.plugin.name,
          providerName: null,
        }).map((line) => (
          <AppText key={line.key} role="secondary" tone={line.key === "trust" ? "default" : "soft"}>
            {line.text}
          </AppText>
        ))}
        {status}
        <AnswerRow>
          <AnswerPill
            busy={session.pendingId === "plugin-account-decline"}
            disabled={locked}
            label="Not now"
            onPress={() =>
              void responder.submit(
                pluginRequestResponses.accountDeclined,
                "plugin-account-decline",
              )
            }
            tone="secondary"
          />
          <AnswerPill
            disabled={locked || deploymentId === null}
            label="Connect account"
            onPress={() =>
              deploymentId !== null &&
              navigation.navigate("PluginConnect", { deploymentId, ...view.target })
            }
            tone="primary"
          />
        </AnswerRow>
      </View>
    );
  }
  if (view.kind === "approval")
    return (
      <View style={styles.section}>
        {who}
        <AppText role="secondary" tone="soft">
          It wants to run {view.tool} with exactly:
        </AppText>
        <View style={styles.mono}>
          <AppText role="caption" selectable style={styles.monoText}>
            {view.argumentsText}
          </AppText>
        </View>
        {status}
        <AnswerRow>
          <AnswerPill
            busy={session.pendingId === "plugin-decline"}
            disabled={locked}
            label="Don’t Allow"
            onPress={() => void responder.submit(pluginRequestResponses.decline, "plugin-decline")}
            tone="secondary"
          />
          <AnswerPill
            busy={session.pendingId === "plugin-approve"}
            disabled={locked}
            label="Allow"
            onPress={() => void responder.submit(pluginRequestResponses.approve, "plugin-approve")}
            tone="primary"
          />
        </AnswerRow>
      </View>
    );
  const content = pluginInputContent(view.form, answers);
  return (
    <View style={styles.section}>
      {who}
      <AppText role="secondary" tone="muted">
        Only {view.plugin.name} receives your answer. The agent never sees it.
      </AppText>
      {view.form.fields.map((field) => (
        <InputField
          disabled={session.pendingId !== null}
          field={field}
          key={field.id}
          onChange={(values) => setAnswers({ ...answers, [field.id]: values })}
          values={answers[field.id] ?? []}
        />
      ))}
      {"problem" in content && view.form.unsupported.length ? (
        <AppText role="caption" tone="muted">
          {content.problem}
        </AppText>
      ) : null}
      {status}
      <AnswerRow>
        <AnswerPill
          busy={session.pendingId === "plugin-input-decline"}
          disabled={locked}
          label="Decline"
          onPress={() =>
            void responder.submit(pluginRequestResponses.inputDeclined, "plugin-input-decline")
          }
          tone="secondary"
        />
        <AnswerPill
          busy={session.pendingId === "plugin-input"}
          disabled={locked || "problem" in content}
          label="Send"
          onPress={() =>
            "content" in content &&
            void responder.submit(pluginRequestResponses.input(content.content), "plugin-input")
          }
          tone="primary"
        />
      </AnswerRow>
    </View>
  );
}

function InputField(props: {
  readonly disabled: boolean;
  readonly field: PluginInputField;
  readonly onChange: (values: string[]) => void;
  readonly values: readonly string[];
}): ReactNode {
  const { field, values } = props;
  const label = field.required ? field.prompt : `${field.prompt} (optional)`;
  if (field.kind === "boolean")
    return (
      <SwitchRow
        detail={field.description}
        disabled={props.disabled}
        label={label}
        onChange={(value) => props.onChange([String(value)])}
        value={values[0] === "true"}
      />
    );
  return (
    <View style={styles.field}>
      <AppText role="secondary">{label}</AppText>
      {field.description ? (
        <AppText role="caption" tone="muted">
          {field.description}
        </AppText>
      ) : null}
      {field.kind === "choice" || field.kind === "choices" ? (
        <View style={styles.choices}>
          {field.choices.map((choice) => {
            const chosen = values.includes(choice.value);
            return (
              <AnswerPill
                disabled={props.disabled}
                key={choice.value}
                label={choice.label}
                onPress={() =>
                  props.onChange(
                    field.kind === "choice"
                      ? chosen
                        ? []
                        : [choice.value]
                      : chosen
                        ? values.filter((value) => value !== choice.value)
                        : [...values, choice.value],
                  )
                }
                tone={chosen ? "primary" : "secondary"}
              />
            );
          })}
        </View>
      ) : (
        <TextInput
          accessibilityLabel={label}
          cursorColor={color.ember}
          editable={!props.disabled}
          keyboardType={field.kind === "text" ? "default" : "numbers-and-punctuation"}
          maxFontSizeMultiplier={controlFontScaleLimit}
          onChangeText={(value) => props.onChange([value])}
          selectionColor={color.ember}
          style={[type.secondary, styles.input]}
          value={values[0] ?? ""}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space[6] },
  field: { gap: space[6] },
  input: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: radius.lg,
    color: color.text,
    minHeight: touchTarget,
    paddingHorizontal: space[14],
    paddingVertical: space[10],
  },
  mono: {
    backgroundColor: color.surfaceCode,
    borderRadius: radius.lg,
    paddingHorizontal: space[14],
    paddingVertical: space[12],
  },
  monoText: { color: color.textSoft, fontFamily: monoFontFamily },
  section: { gap: space[10] },
});
