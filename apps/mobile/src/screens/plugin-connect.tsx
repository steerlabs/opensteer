import {
  createPluginAccountAttempt,
  forgetPluginOAuthApp,
  linkPluginAccount,
  pluginAccountComplete,
  pluginAccountValues,
  pluginConsentLines,
  pluginLinkableAccounts,
  pluginSignInRetryable,
  readPluginAccountReview,
  type PluginAccountReviewView,
  type PluginRequirementTarget,
} from "@opensteer/client/plugins";
import { usePluginSignIn } from "@opensteer/client/react";
import type { HostClient } from "@opensteer/client/host";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useScreenAction, settingsFooter } from "../ui/client-feedback.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { usePluginAction } from "./plugins.js";
import { usePluginRead } from "./use-plugin-read.js";
import { addressWords } from "../ui/address-words.js";

type Params = StaticScreenProps<{
  readonly deploymentId: string;
  readonly pluginId: string;
  readonly requirement: string;
  readonly scope: "app" | "user";
}>;

/**
 * Connecting an account to one plugin requirement, from its page or from the
 * Request that asks for it: what linking agrees to, then the ways in. Closing
 * leaves a sign-in in the browser running; only Cancel ends it.
 */
export function PluginConnectScreen({ route }: Params): ReactNode {
  const { deploymentId, pluginId, requirement, scope } = route.params;
  const host = useAttachedHost(deploymentId);
  const target = useMemo(() => ({ pluginId, requirement, scope }), [pluginId, requirement, scope]);
  return host ? (
    <Connect host={host} target={target} />
  ) : (
    <DeploymentGate deploymentId={deploymentId} />
  );
}

function Connect({ host, target }: { host: HostClient; target: PluginRequirementTarget }) {
  const navigation = useNavigation();
  const review = usePluginRead(
    host,
    () => readPluginAccountReview(host, target),
    `plugin-account-review:${target.pluginId}:${target.requirement}:${target.scope}`,
    "what this plugin asks for",
    { pluginId: target.pluginId },
  );
  const done = () => {
    if (navigation.canGoBack()) navigation.goBack();
  };
  if (!review.data)
    return (
      <NativeSettingsPage
        sections={[
          {
            key: "loading",
            title: "",
            rows: [
              {
                key: "loading",
                kind: "text",
                label: review.error ?? "Loading what this plugin asks for…",
              },
            ],
          },
        ]}
      />
    );
  const body = { host, onLinked: done, review: review.data, target };
  return review.data.signIn ? (
    <ConnectWithSignIn {...body} />
  ) : (
    <ConnectBody {...body} signIn={[]} />
  );
}

type BodyProps = {
  host: HostClient;
  onLinked: () => void;
  review: PluginAccountReviewView;
  target: PluginRequirementTarget;
};
function ConnectWithSignIn(props: BodyProps) {
  const signIn = useSignInSections({
    host: props.host,
    onLinked: props.onLinked,
    providerName: props.review.requirement.providerName,
    target: props.target,
  });
  return <ConnectBody {...props} signIn={signIn} />;
}

function ConnectBody(props: BodyProps & { signIn: readonly NativeSettingsSection[] }) {
  const { host, review, target } = props;
  const action = usePluginAction(
    host,
    `connect:${target.pluginId}:${target.requirement}:${target.scope}`,
    "connect the account",
    "connected",
  );
  const createAccount = useMemo(() => createPluginAccountAttempt(host), [host]);
  const [method, setMethod] = useState(review.methods[0]?.method ?? null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const fields = review.methods.find((entry) => entry.method === method)?.fields ?? [];
  const saved = pluginLinkableAccounts(review);
  const provider = review.requirement.providerName;
  const sections: NativeSettingsSection[] = [
    {
      key: "consent",
      title: "What linking agrees to",
      rows: pluginConsentLines({
        consent: review.consent,
        author: review.plugin.author,
        pluginName: review.plugin.name,
        providerName: provider,
      }).map((line) => ({ key: line.key, kind: "text" as const, label: line.text })),
      ...(action.footer ? { footer: action.footer } : {}),
    },
  ];
  sections.push(...props.signIn);
  if (saved.length)
    sections.push({
      key: "saved",
      title: "Use a saved account",
      rows: saved.map((account) => ({
        key: account.id,
        kind: "button" as const,
        label: account.label,
        ...(account.linked ? { detail: `Linked to ${review.plugin.name}` } : {}),
        disabled: action.pending !== null,
        onPress: () =>
          action.run(`link:${account.id}`, async () => {
            await linkPluginAccount(host, target, account.id, review.consent);
            props.onLinked();
          }),
      })),
    });
  if (review.methods.length)
    sections.push({
      key: "key",
      title: saved.length || review.signIn ? "Or add an API key" : "Add an API key",
      rows: [
        ...(review.methods.length > 1
          ? [
              {
                key: "method",
                kind: "chips" as const,
                label: "How to connect",
                value: method ?? "",
                choices: review.methods.map((entry) => ({
                  value: entry.method,
                  label: entry.label,
                })),
                onChange: setMethod,
              },
            ]
          : []),
        ...fields.map((field): NativeSettingsRow =>
          field.choices
            ? {
                key: field.name,
                kind: "chips",
                label: field.required ? field.title : `${field.title} (optional)`,
                value: values[field.name] ?? "",
                choices: field.choices.map((choice) => ({
                  value: String(choice),
                  label: String(choice),
                })),
                onChange: (value) => setValues({ ...values, [field.name]: value }),
              }
            : {
                key: field.name,
                kind: "input",
                label: field.required ? field.title : `${field.title} (optional)`,
                secure: !field.plain && field.type === "string",
                value: values[field.name] ?? "",
                onChange: (value) => setValues({ ...values, [field.name]: value }),
              },
        ),
        {
          key: "label",
          kind: "input",
          label: "Name (optional)",
          value: label,
          onChange: setLabel,
        },
        {
          key: "create",
          kind: "primary",
          pinned: true,
          label: action.pending === "create" ? "Connecting…" : "Save and link",
          disabled: !method || !pluginAccountComplete(fields, values) || action.pending !== null,
          onPress: () =>
            method &&
            action.run("create", async () => {
              await createAccount({
                provider: review.requirement.provider,
                method,
                fields: pluginAccountValues(fields, values),
                ...(label.trim() ? { label: label.trim() } : {}),
                link: { ...target, consent: review.consent },
              });
              props.onLinked();
            }),
        },
      ],
    });
  if (!review.methods.length && !saved.length && !review.signIn)
    sections.push({
      key: "none",
      title: "",
      rows: [
        { key: "none", kind: "text", label: `${provider} accounts can't be connected from here.` },
      ],
    });
  return <NativeSettingsPage sections={sections} />;
}

/** The sign-in part of the page: its rows follow the shared sign-in step by step. */
function useSignInSections(input: {
  host: HostClient;
  onLinked: () => void;
  providerName: string;
  target: PluginRequirementTarget;
}): NativeSettingsSection[] {
  const mobile = useMobileClient();
  const surface = useMemo(() => mobile.pluginSignInSurface(), [mobile]);
  const { flow, state } = usePluginSignIn({
    client: input.host,
    surface,
    target: input.target,
    providerName: input.providerName,
  });
  const [ownApp, setOwnApp] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [remember, setRemember] = useState(true);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const forget = useScreenAction(
    input.host,
    `plugin-oauth-forget:${input.target.pluginId}:${input.target.requirement}`,
    {
      label: "forget this app",
      done: "removed",
      execute: (app: string) => forgetPluginOAuthApp(input.host, app),
    },
  );
  const linked = state.step === "ended" && state.end.kind === "completed";
  const reported = useRef(false);
  useEffect(() => {
    if (!linked || reported.current) return;
    reported.current = true;
    input.onLinked();
  }, [linked, input]);
  if (state.step === "preparing")
    return [
      {
        key: "sign-in",
        title: "Sign in",
        rows: [{ key: "preparing", kind: "text", label: "Getting sign-in ready…" }],
      },
    ];
  if (state.step === "ended") {
    if (state.end.kind === "completed") return [];
    const { end } = state;
    return [
      {
        key: "sign-in",
        title: "Sign in",
        rows: [
          {
            key: "ended",
            kind: "status",
            tone: end.kind === "cancelled" ? "neutral" : "bad",
            label: end.message,
          },
          ...(pluginSignInRetryable(end)
            ? [
                {
                  key: "again",
                  kind: "button" as const,
                  label: end.kind === "review-changed" ? "Review again" : "Try again",
                  onPress: () => void flow.prepare(),
                },
              ]
            : []),
        ],
        ...(end.kind === "account-link-required"
          ? {
              footer: {
                text: "Link it in Settings → Account on the computer itself, then sign in again.",
              },
            }
          : {}),
      },
    ];
  }
  const { choices } = state;
  if (!choices.options.length && !choices.ownApp) return [];
  if (state.step === "waiting")
    return [
      {
        key: "sign-in",
        title: "Sign in",
        rows: [
          {
            key: "waiting",
            kind: "status",
            tone: "attention",
            label: "Finish signing in in the browser. This updates by itself.",
          },
          {
            key: "cancel",
            kind: "button",
            label: state.cancelling ? "Cancelling…" : "Cancel sign-in",
            destructive: true,
            disabled: state.cancelling,
            onPress: () => void flow.cancel(),
          },
          ...(state.statusFailed
            ? [
                {
                  key: "recheck",
                  kind: "button" as const,
                  label: "Try again",
                  detail: "Couldn't load authorization status.",
                  onPress: () => flow.retryStatus(),
                },
              ]
            : []),
        ],
        ...(state.issue ? { footer: { text: state.issue } } : {}),
      },
    ];
  const busy = state.step === "starting";
  const form = choices.ownApp;
  const rows: NativeSettingsRow[] = choices.options.map((option, index) =>
    index === 0 && option.kind === "one-click"
      ? {
          key: option.key,
          kind: "primary",
          label: busy && state.key === option.key ? "Opening…" : option.label,
          disabled: busy || forgetting !== null,
          onPress: () => flow.start({ option }),
        }
      : {
          key: option.key,
          kind: "button",
          label: busy && state.key === option.key ? "Opening…" : option.label,
          ...(option.detail ? { detail: option.detail } : {}),
          disabled: busy || forgetting !== null,
          onPress: () => flow.start({ option }),
          ...(option.savedApp
            ? {
                actions: [
                  {
                    label: "Forget this app",
                    destructive: true,
                    onPress: () => {
                      const app = option.savedApp!;
                      setForgetting(app);
                      void forget
                        .run(app)
                        .then((result) =>
                          result.kind === "confirmed" ? flow.prepare() : undefined,
                        )
                        .finally(() => setForgetting(null));
                    },
                  },
                ],
              }
            : {}),
        },
  );
  const sections: NativeSettingsSection[] = [
    {
      key: "sign-in",
      title: "Sign in",
      rows: [
        ...rows,
        ...(form && !ownApp
          ? [
              {
                key: "own",
                kind: "button" as const,
                label: "Use your own OAuth app",
                opens: true,
                disabled: busy,
                onPress: () => setOwnApp(true),
              },
            ]
          : []),
      ],
      ...(forget.line
        ? { footer: settingsFooter(forget.line)! }
        : state.step === "choosing" && state.issue
          ? { footer: { text: state.issue } }
          : choices.options[0]?.kind === "one-click" && choices.options[0].detail
            ? { footer: { text: choices.options[0].detail } }
            : choices.oneClickUnavailable
              ? { footer: { text: choices.oneClickUnavailable } }
              : {}),
    },
  ];
  if (form && ownApp) {
    const ready =
      clientId.trim() !== "" && (form.secret !== "required" || clientSecret.trim() !== "");
    sections.push({
      key: "own-app",
      title: "Your own OAuth app",
      rows: [
        {
          key: "redirect",
          kind: "status",
          tone: "neutral",
          label: "Register this as the redirect URL",
          detail: addressWords(form.redirectUri),
        },
        ...(form.scopes.length
          ? [
              {
                key: "scopes",
                kind: "text" as const,
                label: "It asks for",
                detail: form.scopes.join(" "),
              },
            ]
          : []),
        { key: "id", kind: "input", label: "Client ID", value: clientId, onChange: setClientId },
        ...(form.secret === "none"
          ? []
          : [
              {
                key: "secret",
                kind: "input" as const,
                label: form.secret === "optional" ? "Client secret (optional)" : "Client secret",
                secure: true,
                value: clientSecret,
                onChange: setClientSecret,
              },
            ]),
        {
          key: "remember",
          kind: "toggle",
          label: "Remember this app",
          detail: "Offer it again for the next sign-in",
          value: remember,
          onChange: setRemember,
        },
        {
          key: "go",
          kind: "primary",
          label: busy && state.key === "own-app" ? "Opening…" : "Sign in with this app",
          disabled: !ready || busy,
          onPress: () =>
            flow.start({
              ownApp: {
                clientId,
                ...(form.secret === "none" ? {} : { clientSecret }),
                save: remember,
              },
            }),
        },
      ],
    });
  }
  return sections;
}
