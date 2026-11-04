import { useState, useSyncExternalStore } from "react";
import {
  backgroundConsentDismissalKey,
  backgroundModelsLead,
  backgroundModelsSettings,
  backgroundModelsTitle,
  backgroundProvidersNote,
  dismissedBackgroundProviders,
  getBackgroundModels,
  setBackgroundModelRole,
  setBackgroundProviderConsent,
  unwrapRpcResult,
  type BackgroundConsentNotice,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { Icon } from "../../icon.js";
import { browserNoticeDismissals } from "../../usage-notice.js";
import { SettingsError, SettingsGroup, SettingsRow } from "../primitives.js";
import { useSettingsRead } from "../use-settings-read.js";

const noticeStorageKey = "opensteer.background-notices.dismissed";

/** Which models do Opensteer's own small jobs, and which providers may. */
export function BackgroundModelsSection() {
  const { hostClient, snapshot } = useShell();
  const read = useSettingsRead(
    async () => unwrapRpcResult(await getBackgroundModels(hostClient)),
    "background-models",
  );
  const store = browserNoticeDismissals(noticeStorageKey);
  // Unknown until this device's storage answers, so nothing is asked twice.
  const keys = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
  const scope =
    snapshot.deploymentId && snapshot.user
      ? { deploymentId: snapshot.deploymentId, userId: snapshot.user.id }
      : null;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const change = (mutation: () => ReturnType<typeof setBackgroundProviderConsent>) => {
    setPending(true);
    setFailure(null);
    void mutation()
      .then(unwrapRpcResult)
      .then(read.reload, (error: unknown) => setFailure(actionErrorMessage(error)))
      .finally(() => setPending(false));
  };
  if (read.data === null)
    return (
      <SettingsGroup heading={backgroundModelsTitle} headingId="background-models">
        {read.error ? (
          <SettingsError message="Background models could not be loaded." />
        ) : (
          <p role="status">Loading background models…</p>
        )}
      </SettingsGroup>
    );
  const settings = backgroundModelsSettings(
    read.data,
    scope ? dismissedBackgroundProviders(keys, scope) : null,
  );
  const allow = (providerId: BackgroundConsentNotice["providerId"], allowed: boolean) =>
    change(() => setBackgroundProviderConsent(hostClient, providerId, allowed));
  return (
    <>
      {settings.notice && scope ? (
        <ConsentNotice
          disabled={pending}
          notice={settings.notice}
          onAllow={() => allow(settings.notice!.providerId, true)}
          onNotNow={() =>
            store.dismiss(
              backgroundConsentDismissalKey({ ...scope, providerId: settings.notice!.providerId }),
            )
          }
        />
      ) : null}
      <SettingsGroup
        heading={backgroundModelsTitle}
        headingId="background-models"
        note={backgroundModelsLead}
      >
        {settings.roles.map((role) => (
          <SettingsRow
            key={role.role}
            icon={role.role === "light" ? "sparkles" : "brain"}
            title={role.title}
            detail={role.detail}
            action={
              <select
                aria-label={role.title}
                disabled={pending}
                value={role.value}
                onChange={(event) => {
                  const choice = role.choices.find(
                    (item) => item.value === event.currentTarget.value,
                  );
                  if (choice)
                    change(() => setBackgroundModelRole(hostClient, role.role, choice.mode));
                }}
              >
                {role.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            }
          />
        ))}
      </SettingsGroup>
      {settings.providers.length > 0 ? (
        <SettingsGroup
          heading="Providers for background work"
          headingId="background-providers"
          note={backgroundProvidersNote}
        >
          {settings.providers.map((provider) => (
            <SettingsRow
              key={provider.providerId}
              icon="shield"
              title={provider.name}
              detail={provider.allowed ? "Allowed" : "Not allowed"}
              action={
                <button
                  aria-label={`${provider.allowed ? "Revoke" : "Allow"} ${provider.name}`}
                  className="btn btn--small"
                  disabled={pending}
                  onClick={() => allow(provider.providerId, !provider.allowed)}
                  type="button"
                >
                  {provider.allowed ? "Revoke" : "Allow"}
                </button>
              }
            />
          ))}
        </SettingsGroup>
      ) : null}
      <SettingsError message={failure} />
    </>
  );
}

function ConsentNotice({
  disabled,
  notice,
  onAllow,
  onNotNow,
}: {
  readonly disabled: boolean;
  readonly notice: BackgroundConsentNotice;
  readonly onAllow: () => void;
  readonly onNotNow: () => void;
}) {
  return (
    <div aria-label={`Allow ${notice.name}?`} className="notice notice--accent" role="region">
      <Icon name="sparkles" />
      <div>{notice.text}</div>
      <button className="btn btn--small" disabled={disabled} onClick={onAllow} type="button">
        Allow
      </button>
      <button className="btn btn--small" onClick={onNotNow} type="button">
        Not now
      </button>
    </div>
  );
}
