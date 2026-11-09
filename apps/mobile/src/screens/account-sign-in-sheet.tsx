import {
  addAccountChoice,
  type AccountSignInFlow,
  type AccountSignInState,
  type AddAccountChoice,
} from "@opensteer/client/host";
import type { HarnessSetupMethod, HarnessSourceDescriptor } from "@opensteer/protocol";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from "react-native";
import { color, radius, space, touchTarget } from "../theme.js";
import { useCopy } from "../ui/copy-mark.js";
import {
  AppText,
  Field,
  monoFontFamily,
  Notice,
  PrimaryButton,
  SecondaryButton,
} from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { AddAccountFields, useAddAccountForm } from "./add-account-form.js";

const noSources: readonly HarnessSourceDescriptor[] = [];
const noSubscribe = () => () => undefined;
const noState = () => null;

function alternativeLabel(method: HarnessSetupMethod): string {
  return method.kind === "secret-input" ? "Use an API key instead" : `Use ${method.label} instead`;
}

/**
 * Every way into an AI account, drawn from one flow: a code to enter, a page
 * that hands one back, or a key to paste. It only draws what the flow reports,
 * so web and mobile cannot disagree about what happens next.
 */
export function AccountSignInSheet(props: {
  /** Asked first, in this same sheet, when adding needs a choice or a field. */
  readonly choosing: {
    readonly onContinue: (choice: AddAccountChoice) => void;
    readonly sources: readonly HarnessSourceDescriptor[];
  } | null;
  readonly flow: AccountSignInFlow | null;
  readonly onClose: () => void;
  readonly onDone: (state: Extract<AccountSignInState, { readonly kind: "done" }>) => void;
  readonly title: string;
  readonly whereLabel: string;
}): ReactNode {
  const { choosing, flow, onClose, onDone, whereLabel } = props;
  const state = useSyncExternalStore(flow?.subscribe ?? noSubscribe, flow?.getState ?? noState);
  const form = useAddAccountForm(choosing?.sources ?? noSources);
  const signingIn = state?.kind === "signing-in" ? state : null;
  const method = signingIn?.methods.find(({ methodId }) => methodId === signingIn.methodId) ?? null;
  const view = signingIn?.session?.view ?? null;
  const pending = view?.kind === "pending" ? view : null;
  const code = pending && pending.inputPrompt === undefined ? pending.userCode : null;

  const [opened, setOpened] = useState(false);
  const [unopenedUrl, setUnopenedUrl] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const { copied, copy } = useCopy({ onFailure: () => setCopyFailed(true) });

  const methodId = signingIn?.methodId ?? null;
  useEffect(() => {
    setOpened(false);
    setUnopenedUrl(null);
    setValue("");
  }, [methodId]);
  useEffect(() => {
    setCopyFailed(false);
  }, [code]);

  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || state === null) return;
    if (state.kind === "done") {
      settled.current = true;
      onDone(state);
    } else if (state.kind === "cancelled") {
      settled.current = true;
      onClose();
    }
  }, [onClose, onDone, state]);

  const open = (url: string): Promise<void> =>
    Linking.openURL(url).then(
      () => {
        setOpened(true);
        setUnopenedUrl(null);
      },
      () => setUnopenedUrl(url),
    );
  const copyCode = (text: string): Promise<void> => {
    setCopyFailed(false);
    return copy(text);
  };
  const submit = (): void => {
    if (!flow || !pending || value.length === 0 || submitting) return;
    setSubmitting(true);
    void flow
      .submit(value)
      .then(() => setValue(""))
      .finally(() => setSubmitting(false));
  };

  const retry = flow ? <PrimaryButton label="Try again" onPress={() => flow.retry()} /> : null;
  const alternatives =
    flow && signingIn
      ? signingIn.methods
          .filter((candidate) => candidate.methodId !== signingIn.methodId)
          .map((candidate) => (
            <SecondaryButton
              key={candidate.methodId}
              label={alternativeLabel(candidate)}
              onPress={() => flow.chooseMethod(candidate.methodId)}
            />
          ))
      : null;
  const failure = signingIn?.error ?? (view?.kind === "failed" ? view.detail : null);
  const failed =
    failure === null ? null : <Notice detail={failure} title="Sign-in didn’t finish" />;
  const couldNotOpen =
    unopenedUrl === null ? null : (
      <Notice detail={`Open ${unopenedUrl} in your browser.`} title="Your browser didn’t open" />
    );

  let body: ReactNode;
  let footer: ReactNode = null;

  if (choosing !== null) {
    const { source } = form;
    body = <AddAccountFields form={form} whereLabel={whereLabel} />;
    footer = (
      <PrimaryButton
        disabled={!form.complete}
        label={source?.kind === "compatible-endpoint" ? "Connect" : "Continue"}
        onPress={() => {
          if (source && form.complete) choosing.onContinue(addAccountChoice(source, form.values));
        }}
      />
    );
  } else if (state?.kind === "finishing") {
    body = <Status>Signed in. Finishing up…</Status>;
  } else if (state?.kind === "duplicate" && flow) {
    body = (
      <Said>{`${state.accountLabel} is already added. Your browser may have used that account.`}</Said>
    );
    footer = (
      <View style={styles.footer}>
        <SecondaryButton label="Keep both" onPress={() => flow.keepDuplicate()} />
        <PrimaryButton label="Remove this one" onPress={() => void flow.removeDuplicate()} />
      </View>
    );
  } else if (state?.kind === "failed") {
    body = <Notice detail={state.message} title="Sign-in didn’t finish" />;
    footer = retry;
  } else if (view?.kind === "disconnected") {
    body = (
      <>
        <Said>{`${whereLabel} is offline. Sign-in continues when it’s back.`}</Said>
        {alternatives}
      </>
    );
  } else if (failure !== null && !pending && method?.kind !== "secret-input") {
    body = (
      <>
        {failed}
        {alternatives}
      </>
    );
    footer = retry;
  } else if (method?.kind === "secret-input") {
    body = (
      <>
        {failed}
        <Field
          hint={`Stored only on ${whereLabel}.`}
          input={{
            autoCapitalize: "none",
            autoComplete: "off",
            autoCorrect: false,
            autoFocus: true,
            editable: !submitting,
            onChangeText: setValue,
            onSubmitEditing: submit,
            ...(method.inputPlaceholder ? { placeholder: method.inputPlaceholder } : {}),
            returnKeyType: "done",
            secureTextEntry: true,
            spellCheck: false,
            value,
          }}
          label={pending?.inputPrompt ?? method.inputLabel}
        />
        {alternatives}
      </>
    );
    footer = (
      <PrimaryButton
        busy={submitting}
        disabled={!pending || value.length === 0}
        label="Save"
        onPress={submit}
      />
    );
  } else if (pending && code !== null) {
    const url = pending.verificationUrl;
    body = (
      <>
        <AppText>Enter this code on the page that opens.</AppText>
        <View style={styles.code}>
          <AppText
            accessibilityLabel="One-time code"
            role="title"
            selectable
            style={styles.codeText}
          >
            {code}
          </AppText>
          <Pressable
            accessibilityLabel={copied ? "Copied" : "Copy code"}
            accessibilityRole="button"
            onPress={() => void copyCode(code)}
            style={({ pressed }) => [styles.copy, pressed && styles.copyPressed]}
          >
            <AppText role="secondaryMedium" tone="ember">
              {copied ? "Copied" : "Copy"}
            </AppText>
          </Pressable>
        </View>
        {copyFailed ? (
          <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
            <AppText role="secondary" tone="danger">
              Couldn’t copy. Select the code and copy it yourself.
            </AppText>
          </View>
        ) : null}
        {pending.codeReplaced ? <Said>You have a new code. Use this one.</Said> : null}
        {failed}
        {couldNotOpen}
        {opened && failure === null ? (
          <Status>Waiting for you to finish in your browser…</Status>
        ) : null}
        {alternatives}
      </>
    );
    footer =
      failure !== null ? (
        retry
      ) : url === undefined ? null : opened ? (
        <SecondaryButton label="Open browser again" onPress={() => void open(url)} />
      ) : (
        <PrimaryButton
          label="Copy code and open browser"
          onPress={() => void copyCode(code).then(() => open(url))}
        />
      );
  } else if (pending) {
    const url = pending.verificationUrl;
    const asking = opened || url === undefined;
    body = (
      <>
        <AppText>Sign in on the page that opens.</AppText>
        {failed}
        {couldNotOpen}
        {asking ? (
          <Field
            input={{
              autoCapitalize: "none",
              autoCorrect: false,
              editable: !submitting,
              onChangeText: setValue,
              onSubmitEditing: submit,
              returnKeyType: "done",
              spellCheck: false,
              value,
            }}
            label={pending.inputPrompt ?? "Code"}
          />
        ) : null}
        {alternatives}
      </>
    );
    footer = asking ? (
      <View style={styles.footer}>
        {url === undefined ? null : (
          <SecondaryButton label="Open again" onPress={() => void open(url)} />
        )}
        <PrimaryButton
          busy={submitting}
          disabled={value.length === 0}
          label="Submit"
          onPress={submit}
        />
      </View>
    ) : (
      <PrimaryButton label="Open sign-in page" onPress={() => void open(url)} />
    );
  } else {
    body = (
      <>
        <Status>Getting ready…</Status>
        {alternatives}
      </>
    );
  }

  return (
    <Sheet footer={footer} onClose={onClose} open title={props.title}>
      <View style={styles.body}>{body}</View>
    </Sheet>
  );
}

function Said(props: { readonly children: string }): ReactNode {
  return (
    <View accessibilityLiveRegion="polite">
      <AppText>{props.children}</AppText>
    </View>
  );
}

function Status(props: { readonly children: string }): ReactNode {
  return (
    <View accessibilityLiveRegion="polite" style={styles.status}>
      <ActivityIndicator color={color.muted} />
      <AppText role="secondary" style={styles.statusText} tone="soft">
        {props.children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: space[16], paddingHorizontal: space[20], paddingTop: space[12] },
  code: {
    alignItems: "center",
    backgroundColor: color.surfaceCode,
    borderColor: color.lineStrong,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[12],
    paddingLeft: space[14],
    paddingVertical: space[6],
  },
  codeText: { flex: 1, fontFamily: monoFontFamily },
  copy: {
    alignItems: "center",
    borderRadius: radius.xs,
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
    paddingHorizontal: space[12],
  },
  copyPressed: { backgroundColor: color.surfacePressed },
  footer: { gap: space[8] },
  status: { alignItems: "center", flexDirection: "row", gap: space[10] },
  statusText: { flexShrink: 1 },
});
