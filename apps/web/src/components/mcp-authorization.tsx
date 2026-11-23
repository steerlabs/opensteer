import { AgentWhoLine } from "./settings/agent-who.js";
import {
  AgentConnectionAuthorizationTargetSchema,
  agentConnectionDeepLink,
  type AgentConnectionConsent,
} from "@opensteer/protocol";
import {
  opensteerDesktopClient,
  opensteerMobileClient,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { classifyClientFailure } from "@opensteer/client/connections";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon.js";
import { SectionHeader, SettingsRow } from "./settings/primitives.js";
import {
  accessModeOptions,
  agentClaim,
  agentConsentHeading,
  workWords,
  agentBrowserOptions,
  agentHomeName,
  agentWords,
  answerAgentConnection,
  connectedAgentIdentity,
  connectionDestination,
  consentVerificationChanged,
  draftForCatalog,
  createDedicatedProfile,
  grantFromDraft,
  unwrapRpcResult,
  type AgentGrantDraft,
  type HostClient,
  type HostSnapshot,
  type SentencePart,
  agentSentence,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { AgentGrantEditor, ConnectionModeChoices } from "./settings/agent-grant-editor.js";
import { SentenceText } from "../ui/address-text.js";
import { AgentMark } from "./settings/agent-mark.js";
import { QrCode } from "./first-run/qr-code.js";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly consent: AgentConnectionConsent }
  | { readonly kind: "expired" }
  | { readonly kind: "answered" }
  | { readonly kind: "failed" }
  | { readonly kind: "missing" };

const selectProfiles = (snapshot: HostSnapshot) => snapshot.browserProfiles;
const selectProfileHomes = (snapshot: HostSnapshot) => snapshot.browserProfileHomes;
const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;
const selectIdentity = (snapshot: HostSnapshot) => snapshot.identityConfig;

function failureCode(error: unknown): string {
  return classifyClientFailure(error).code;
}

/**
 * An agent asking to use this Opensteer, approved here and never in the agent.
 * With a Home that stores grants the person chooses what it can use, defaulting to
 * a new dedicated profile; an older Home keeps the simple consent it understands.
 */
export function McpAuthorization({
  client,
  requestId,
  desktopBridge = null,
  onClose,
}: {
  readonly client: HostClient;
  readonly requestId: string | null;
  readonly desktopBridge?: Pick<OpensteerDesktopBridge, "openExternalUrl"> | null;
  readonly onClose?: (() => void) | undefined;
}) {
  const profiles = useHostSelector(client, selectProfiles);
  const profileHomes = useHostSelector(client, selectProfileHomes);
  const machines = useHostSelector(client, selectMachines);
  const identityConfig = useHostSelector(client, selectIdentity);
  const browser = agentBrowserOptions({
    browserProfiles: profiles,
    ...(profileHomes === undefined ? {} : { browserProfileHomes: profileHomes }),
    machines,
  });
  const home = agentHomeName({ machines, identityConfig });
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const grantsAvailable = load.kind === "ready" && load.consent.grantsAvailable === true;
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The Home refused an approval because who the agent is changed: it was read again.
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<ThreadAccessMode>("approval-required");
  const [draft, setDraft] = useState<AgentGrantDraft | null>(null);
  // A retried approval reuses the profile the first attempt created.
  const createdProfile = useRef<string | null>(null);
  const revision = useRef(0);
  const defaultHome = browser.defaultHome;
  const canCreate = browser.homes === null || browser.homes.length > 0;
  useEffect(() => {
    const controller = new AbortController();
    ++revision.current;
    setLoad({ kind: "loading" });
    setError(null);
    setChanged(false);
    setBusy(null);
    setAllowed(false);
    setLabel("");
    setMode("approval-required");
    setDraft(null);
    createdProfile.current = null;
    if (!requestId) {
      setLoad({ kind: "missing" });
      return;
    }
    void client.rpc["connections.authorization.get"]({ requestId }, { signal: controller.signal })
      .then(unwrapRpcResult)
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "ready", consent: result });
        setLabel(agentClaim(result.clientName, 120));
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(failureCode(reason) === "not_found" ? { kind: "expired" } : { kind: "failed" });
      });
    return () => {
      controller.abort();
      ++revision.current;
    };
  }, [attempt, client, requestId]);
  // The default waits for the Devices list, so a new profile lands where the Home keeps them.
  const chosen: AgentGrantDraft = draft ?? {
    scope: "selected",
    tasks: false,
    resources: [],
    newProfile: canCreate ? { homeRunnerId: defaultHome } : null,
  };

  async function decide(approve: boolean) {
    if (load.kind !== "ready" || busy) return;
    const { consent } = load;
    const current = revision.current;
    setBusy(approve ? "allow" : "deny");
    setError(null);
    setChanged(false);
    const stale = () => current !== revision.current;
    try {
      let grant;
      if (approve && grantsAvailable) {
        if (chosen.scope === "selected" && chosen.newProfile && !createdProfile.current) {
          try {
            createdProfile.current = await createDedicatedProfile(client, {
              name: label,
              homeRunnerId: chosen.newProfile.homeRunnerId,
            });
          } catch {
            if (stale()) return;
            setError(agentWords("consent.error.newProfile"));
            setBusy(null);
            return;
          }
          if (stale()) return;
        }
        grant = grantFromDraft(
          chosen,
          chosen.scope === "selected" && chosen.newProfile
            ? (createdProfile.current ?? undefined)
            : undefined,
        );
      }
      const completion = await answerAgentConnection(
        client,
        consent,
        approve
          ? { kind: "approve", label, accessMode: mode, ...(grant ? { grant } : {}) }
          : { kind: "deny" },
      );
      if (stale()) return;
      if (approve) setAllowed(true);
      if (desktopBridge) {
        await desktopBridge.openExternalUrl({ url: completion });
        if (!stale()) onClose?.();
      } else window.location.assign(completion);
    } catch (reason) {
      if (stale()) return;
      if (approve && consentVerificationChanged(reason)) {
        await reviewAgain(consent.requestId, stale);
        return;
      }
      const code = failureCode(reason);
      if (code === "conflict") setLoad({ kind: "answered" });
      else if (code === "not_found") setLoad({ kind: "expired" });
      else
        setError(
          agentWords(
            classifyClientFailure(reason).kind === "rejection"
              ? approve
                ? "consent.error.approve"
                : "consent.error.deny"
              : approve
                ? "consent.error.approveUnknown"
                : "consent.error.denyUnknown",
          ),
        );
      setBusy(null);
    }
  }

  /** Shows the consent as the Home now presents it, keeping the choices it still offers. */
  async function reviewAgain(id: string, stale: () => boolean) {
    try {
      const fresh = unwrapRpcResult(
        await client.rpc["connections.authorization.get"]({ requestId: id }),
      );
      if (stale()) return;
      setLoad({ kind: "ready", consent: fresh });
      setDraft((current) => current && draftForCatalog(current, fresh));
      setChanged(true);
    } catch (reason) {
      if (stale()) return;
      setLoad(failureCode(reason) === "not_found" ? { kind: "expired" } : { kind: "failed" });
    }
    setBusy(null);
  }

  return (
    <main className="page settings settings-layout">
      <div className="settings-content">
        <div className="settings-content__inner agent-consent">
          {load.kind === "loading" ? <p role="status">{agentWords("consent.loading")}</p> : null}
          {load.kind === "missing" ? (
            <p className="notice notice--error" role="alert">
              {agentWords("consent.missing")}
            </p>
          ) : null}
          {load.kind === "expired" ? (
            <ConsentEnded
              detail={agentWords("consent.edge.expired.detailUnnamed")}
              title={agentWords("consent.edge.expired.title")}
            />
          ) : null}
          {load.kind === "answered" ? (
            <ConsentEnded
              detail={agentWords("consent.edge.answered.detail")}
              title={agentWords("consent.edge.answered.title")}
            />
          ) : null}
          {load.kind === "failed" ? (
            <ConsentEnded
              detail={agentWords("consent.edge.failed.detail")}
              onRetry={() => setAttempt((n) => n + 1)}
              title={agentWords("consent.edge.failed.title")}
            />
          ) : null}
          {load.kind === "ready" && allowed ? (
            <div className="card" role="status">
              <SettingsRow
                detail={agentWords("consent.allowed.detail")}
                title={
                  <>
                    <Icon name="check-circle" />
                    {agentWords("consent.allowed.title")}
                  </>
                }
              />
            </div>
          ) : null}
          {load.kind === "ready" && !allowed ? (
            <ConsentForm
              busy={busy}
              changed={changed}
              consent={load.consent}
              error={error}
              grants={
                grantsAvailable
                  ? {
                      browser,
                      client,
                      draft: chosen,
                      home,
                      onDraft: setDraft,
                    }
                  : null
              }
              label={label}
              mode={mode}
              onDecide={(approve) => void decide(approve)}
              onLabel={setLabel}
              onMode={setMode}
            />
          ) : null}
          {onClose ? (
            <button className="btn" type="button" onClick={onClose}>
              Back to Opensteer
            </button>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function ConsentEnded({
  detail,
  onRetry,
  title,
}: {
  readonly detail: string;
  readonly onRetry?: () => void;
  readonly title: string;
}) {
  return (
    <>
      <SectionHeader title={title} lead={detail} />
      {onRetry ? (
        <div>
          <button className="btn" onClick={onRetry} type="button">
            {agentWords("common.tryAgain")}
          </button>
        </div>
      ) : null}
    </>
  );
}

function ConsentForm({
  busy,
  changed,
  consent,
  error,
  grants,
  label,
  mode,
  onDecide,
  onLabel,
  onMode,
}: {
  readonly busy: "allow" | "deny" | null;
  /** Its verification changed since the person last read it, and it was read again. */
  readonly changed: boolean;
  readonly consent: AgentConnectionConsent;
  readonly error: string | null;
  readonly grants: {
    readonly browser: ReturnType<typeof agentBrowserOptions>;
    readonly client: HostClient;
    readonly draft: AgentGrantDraft;
    readonly home: string;
    readonly onDraft: (draft: AgentGrantDraft) => void;
  } | null;
  readonly label: string;
  readonly mode: ThreadAccessMode;
  readonly onDecide: (approve: boolean) => void;
  readonly onLabel: (label: string) => void;
  readonly onMode: (mode: ThreadAccessMode) => void;
}) {
  // Who asked, in the Home's words where it said; never a provider guessed from a domain.
  const identity = connectedAgentIdentity(
    {
      label: label,
      clientName: consent.clientName,
      ...(consent.identity ? { identity: consent.identity } : {}),
      ...(consent.identityAtConsent ? { identityAtConsent: consent.identityAtConsent } : {}),
    },
    consent.redirectUri,
  );
  const heading = agentConsentHeading(identity.who);
  // The Home's verified name is a name; with none, Opensteer's own words for it.
  const agent: SentencePart = heading.mark ? { name: heading.title } : workWords("who.thisAgent");
  const disabled = busy !== null;
  return (
    <>
      <div className="agent-consent__identity">
        {heading.mark ? (
          <AgentMark
            identity={{ ...identity, initial: Array.from(heading.title)[0] ?? "A" }}
            large
          />
        ) : null}
        <SectionHeader title={heading.title} />
      </div>
      {/* Verified: its labelled origins say where access goes. Not: its claim, then where. */}
      {identity.who.verified ? (
        <AgentWhoLine nameShown={false} who={identity.who} />
      ) : (
        <>
          {heading.claim ? (
            <p className="agent-who__claim agent-consent__claim">{heading.claim}</p>
          ) : null}
          <p className="agent-consent__where">
            <Icon name={identity.local ? "laptop" : "globe"} />
            <span>{connectionDestination(consent.redirectUri)}</span>
          </p>
        </>
      )}
      <p className="agent-consent__warning" role="note">
        {identity.who.warning}
      </p>
      {grants ? (
        <>
          <AgentGrantEditor
            agent={agent}
            browser={grants.browser}
            chromeTabs={consent}
            client={grants.client}
            disabled={disabled}
            draft={grants.draft}
            home={grants.home}
            onChange={grants.onDraft}
          />
          <ConnectionModeChoices
            disabled={disabled}
            mode={mode}
            onChange={onMode}
            showSettingsNote={grants.draft.scope === "everything"}
          />
        </>
      ) : (
        <fieldset className="settings-group" disabled={disabled}>
          <legend className="settings-group__title">What it can change</legend>
          <div className="card">
            {accessModeOptions.map((option) => (
              <label className="card__row agent-consent__mode" key={option.mode}>
                <input
                  checked={mode === option.mode}
                  name="agent-consent-mode"
                  onChange={() => onMode(option.mode)}
                  type="radio"
                  value={option.mode}
                />
                <span className="card__row-body">
                  <span className="card__row-title">{option.label}</span>
                  <span className="card__row-detail">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="field">
        <span className="field__label">{agentWords("consent.name.title")}</span>
        <input
          className="text-input"
          disabled={disabled}
          maxLength={120}
          onChange={(event) => onLabel(event.target.value)}
          placeholder={agentWords("consent.name.placeholder")}
          value={label}
        />
      </label>
      <p className="settings-footnote">
        {grants ? (
          <SentenceText parts={agentSentence("consent.finePrint", { agent })} />
        ) : (
          agentWords("consent.legacyFinePrint")
        )}
      </p>
      {changed ? (
        <p className="notice notice--warn" role="alert">
          {agentWords("consent.error.verificationChanged")}
        </p>
      ) : null}
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button className="btn" disabled={disabled} onClick={() => onDecide(false)} type="button">
          {busy === "deny" ? agentWords("consent.denying") : agentWords("consent.deny")}
        </button>
        <button
          className="btn btn--primary"
          disabled={disabled || !label.trim()}
          onClick={() => onDecide(true)}
          type="button"
        >
          {busy === "allow" ? agentWords("consent.allowing") : agentWords("consent.allow")}
        </button>
      </div>
    </>
  );
}

/**
 * A phone or tablet hands the request to the mobile app; anything else to the
 * desktop app. iPad Safari presents itself as a Mac, so touch tells them apart.
 */
function installedClient() {
  const agent = navigator.userAgent;
  return /Android|iPhone|iPad|iPod/u.test(agent) ||
    (/Macintosh/u.test(agent) && navigator.maxTouchPoints > 1)
    ? { client: opensteerMobileClient, device: "phone" as const }
    : { client: opensteerDesktopClient, device: "computer" as const };
}

/**
 * The page an agent's sign-in lands on where nobody is signed in. It approves nothing;
 * on a computer it also offers the same request to the phone, as a code to scan.
 */
export function McpAuthorizationLaunch({
  requestId,
  deploymentId,
}: {
  readonly requestId: string | null;
  readonly deploymentId: string | null;
}) {
  const target = AgentConnectionAuthorizationTargetSchema.safeParse({ requestId, deploymentId });
  const { client, device } = installedClient();
  return (
    <main className="page settings settings-layout">
      <div className="settings-content">
        <div className="settings-content__inner">
          <SectionHeader
            title={agentWords("consent.launch.title")}
            lead={agentWords("consent.launch.lead", { device })}
          />
          {target.success ? (
            <>
              <div>
                <a
                  className="btn btn--primary"
                  href={agentConnectionDeepLink(client.applicationId, target.data)}
                >
                  {agentWords("consent.launch.open")}
                </a>
              </div>
              {device === "computer" ? (
                <div className="agent-consent__handoff">
                  <span className="agent-consent__qr">
                    <QrCode
                      label={agentWords("consent.launch.qrLabel")}
                      value={agentConnectionDeepLink(
                        opensteerMobileClient.applicationId,
                        target.data,
                      )}
                    />
                  </span>
                  <p className="settings-footnote">{agentWords("consent.launch.qr")}</p>
                </div>
              ) : null}
            </>
          ) : (
            <p className="notice notice--error" role="alert">
              {agentWords("consent.launch.invalid")}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
