import {
  addAccountAddressField,
  addAccountComplete,
  addAccountInitialValues,
  normalizeServerAddress,
  serverAddressProblem,
} from "@opensteer/client/host";
import type { HarnessSourceDescriptor, HarnessSourceField } from "@opensteer/protocol";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, space, touchTarget } from "../theme.js";
import { ChoiceMenu } from "../ui/choice-menu.js";
import { AppText, Field, RowGroup, SectionLabel } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/** The sheet's footer needs what its fields hold, so the state sits above both. */
export function useAddAccountForm(sources: readonly HarnessSourceDescriptor[]) {
  const [sourceId, setSourceId] = useState(sources[0]?.sourceId ?? "");
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    addAccountInitialValues(sources[0]),
  );
  // An address is only judged once the person has left it, so typing one out
  // doesn't flash an error at every keystroke on the way.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const source = sources.find((candidate) => candidate.sourceId === sourceId) ?? sources[0];
  return {
    chooseSource: (candidate: HarnessSourceDescriptor) => {
      setSourceId(candidate.sourceId);
      setValues(addAccountInitialValues(candidate));
      setTouched(new Set());
    },
    complete: source !== undefined && addAccountComplete(source, values),
    set: (id: string, value: string) => setValues((current) => ({ ...current, [id]: value })),
    setTouched,
    source,
    sources,
    touched,
    values,
  };
}

export type AddAccountForm = ReturnType<typeof useAddAccountForm>;

/**
 * The list and the fields are rendered from the engine's own declaration, so a
 * new source reaches this sheet with no change here.
 */
export function AddAccountFields(props: {
  readonly form: AddAccountForm;
  readonly whereLabel: string;
}): ReactNode {
  const { form } = props;
  const { source, sources } = form;
  const server = source?.kind === "compatible-endpoint";
  const address = addAccountAddressField(source);
  return (
    <>
      {sources.length > 1 ? (
        <View style={styles.sources}>
          <SectionLabel>Who should this account talk to?</SectionLabel>
          <RowGroup>
            {sources.map((candidate) => {
              const selected = candidate.sourceId === source?.sourceId;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  key={candidate.sourceId}
                  onPress={() => form.chooseSource(candidate)}
                  style={({ pressed }) => [styles.source, pressed && styles.pressed]}
                >
                  <View style={styles.sourceText}>
                    <AppText>{candidate.label}</AppText>
                    {candidate.detail ? (
                      <AppText role="secondary" tone="muted">
                        {candidate.detail}
                      </AppText>
                    ) : null}
                  </View>
                  {selected ? <Symbol name="checkmark" size={15} tint={color.ember} /> : null}
                </Pressable>
              );
            })}
          </RowGroup>
        </View>
      ) : source?.detail ? (
        <AppText role="secondary" tone="muted">
          {source.detail}
        </AppText>
      ) : null}
      {source?.fields.map((field) => {
        const trimmed = (form.values[field.id] ?? "").trim();
        const label = `${server && field === address ? "Address" : field.label}${
          field.required === false ? " (optional)" : ""
        }`;
        if (field.kind === "select")
          return <SelectField field={field} form={form} key={field.id} label={label} />;
        const problem =
          field.kind === "url" && form.touched.has(field.id) && trimmed !== ""
            ? serverAddressProblem(trimmed)
            : null;
        const hint =
          problem ??
          (server && field === address
            ? `Opensteer connects from ${props.whereLabel}, so localhost is that computer.`
            : field.detail);
        return (
          <Field
            {...(hint === undefined ? {} : { hint })}
            input={{
              autoCapitalize: "none",
              autoCorrect: false,
              keyboardType: field.kind === "url" ? "url" : "default",
              onBlur: () => {
                if (field.kind !== "url" || trimmed === "") return;
                form.setTouched((current) => new Set(current).add(field.id));
                if (serverAddressProblem(trimmed) === null)
                  form.set(field.id, normalizeServerAddress(trimmed));
              },
              onChangeText: (value) => form.set(field.id, value),
              placeholder: field.placeholder,
              spellCheck: false,
              value: form.values[field.id] ?? "",
            }}
            key={field.id}
            label={label}
          />
        );
      })}
    </>
  );
}

function SelectField(props: {
  readonly field: HarnessSourceField;
  readonly form: AddAccountForm;
  readonly label: string;
}): ReactNode {
  const { field, form, label } = props;
  const value = form.values[field.id] ?? "";
  const options = field.options ?? [];
  const blank = field.required === false ? "None" : "Choose…";
  return (
    <View style={styles.select}>
      <AppText role="secondaryMedium" tone="soft">
        {label}
      </AppText>
      <ChoiceMenu
        accessibilityLabel={label}
        choices={[
          ...(field.required === false && field.defaultValue === undefined
            ? [{ id: "", title: blank }]
            : []),
          ...options.map((option) => ({ id: option.value, title: option.label })),
        ]}
        label={options.find((option) => option.value === value)?.label ?? blank}
        onChoose={(next) => form.set(field.id, next)}
      />
      {field.detail ? (
        <AppText role="caption" tone="muted">
          {field.detail}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { backgroundColor: color.surfacePressed },
  select: { alignItems: "flex-start", gap: space[6] },
  source: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  sourceText: { flex: 1, gap: space[2] },
  sources: { gap: space[8] },
});
