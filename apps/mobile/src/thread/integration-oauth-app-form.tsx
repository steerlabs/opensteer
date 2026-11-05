import { useState, type ReactNode } from "react";
import { connectProviderManifest } from "@opensteer/client/integrations";
import { AppText, CodeBlock, Field, PrimaryButton } from "../ui/primitives.js";

export function IntegrationOAuthAppForm(props: {
  readonly busy: boolean;
  readonly callbackUrl: string;
  readonly manifest: NonNullable<ReturnType<typeof connectProviderManifest>>;
  readonly onSave: (draft: {
    readonly clientId: string;
    readonly displayName: string;
    readonly installationUrl?: string;
    readonly secrets: Record<string, string>;
  }) => void;
}): ReactNode {
  const [displayName, setDisplayName] = useState(props.manifest.label);
  const [clientId, setClientId] = useState("");
  const [installationUrl, setInstallationUrl] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const complete =
    displayName.trim() !== "" &&
    clientId.trim() !== "" &&
    (!props.manifest.installationUrlRequired || installationUrl.trim() !== "") &&
    props.manifest.secretFields.every((field) => (secrets[field] ?? "") !== "");
  return (
    <>
      <AppText role="secondary" tone="soft">
        Create a {props.manifest.setupLabel} at {props.manifest.setupUrl}, then paste its
        credentials here. Saving the app does not connect an account, and only you can sign in with
        it.
      </AppText>
      {props.manifest.setupSteps.map((setupStep) => (
        <AppText key={setupStep} role="secondary" tone="muted">
          {setupStep}
        </AppText>
      ))}
      <CodeBlock label="Authorized callback URL" text={props.callbackUrl} />
      <Field
        input={{
          autoCapitalize: "none",
          autoCorrect: false,
          onChangeText: setDisplayName,
          value: displayName,
        }}
        label="App name"
      />
      <Field
        input={{
          autoCapitalize: "none",
          autoCorrect: false,
          onChangeText: setClientId,
          value: clientId,
        }}
        label="Client ID"
      />
      {props.manifest.installationUrlRequired ? (
        <Field
          hint="Opensteer uses this exact URL after sign-in so people can choose repositories."
          input={{
            autoCapitalize: "none",
            autoCorrect: false,
            onChangeText: setInstallationUrl,
            value: installationUrl,
          }}
          label="GitHub App installation URL"
        />
      ) : null}
      {props.manifest.secretFields.map((field) => (
        <Field
          hint="Encrypted before storage and never shown again."
          input={{
            autoCapitalize: "none",
            autoCorrect: false,
            onChangeText: (value: string) =>
              setSecrets((current) => ({ ...current, [field]: value })),
            secureTextEntry: true,
            value: secrets[field] ?? "",
          }}
          key={field}
          label={secretLabel(field)}
        />
      ))}
      <PrimaryButton
        busy={props.busy}
        disabled={!complete}
        label="Save app"
        onPress={() =>
          props.onSave({
            clientId: clientId.trim(),
            displayName: displayName.trim(),
            ...(props.manifest.installationUrlRequired
              ? { installationUrl: installationUrl.trim() }
              : {}),
            secrets,
          })
        }
      />
    </>
  );
}

/** Turns `clientSecret` into the label a provider console uses. */
function secretLabel(field: string): string {
  return field
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}
