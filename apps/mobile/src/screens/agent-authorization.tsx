import { classifyClientFailure } from "@opensteer/client/connections";
import {
  accessModeOptions,
  connectionModeDescriptions,
  agentClaim,
  agentConsentHeading,
  agentWhoOriginParts,
  phoneSentence,
  toggleDraftResource,
  workWords,
  agentBrowserOptions,
  agentHomeName,
  agentWords,
  workHomeMark,
  withinWorkPolicy,
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
import {
  useAgentAppOptions,
  useAgentPluginOptions,
  useHostSelector,
  useWorkPolicy,
} from "@opensteer/client/react";
import type { ThreadAccessMode } from "@opensteer/core";
import type { AgentConnectionConsent } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Linking } from "react-native";
import { AgentAuthorizationForm } from "./agent-authorization-form.js";
import { agentAuthorizationFinePrint } from "./agent-authorization-form.types.js";
import { AgentGrantSheetPage } from "./agent-grant-sheet.js";
import {
  agentGrantSections,
  agentModeSection,
  type AgentGrantSheet,
} from "./agent-grant-sections.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

type Props = StaticScreenProps<{ readonly deploymentId: string; readonly requestId: string }>;

/**
 * An agent asking to use Opensteer, opened from the link its sign-in page hands this
 * phone or from the code a computer shows for it.
 */
export function AgentAuthorizationScreen({ route }: Props): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <AgentAuthorization
      key={route.params.requestId}
      deploymentId={route.params.deploymentId}
      host={host}
      requestId={route.params.requestId}
    />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly consent: AgentConnectionConsent }
  | { readonly kind: "expired" }
  | { readonly kind: "answered" }
  | { readonly kind: "failed" };

const selectProfiles = (snapshot: HostSnapshot) => snapshot.browserProfiles;
const selectHomes = (snapshot: HostSnapshot) => snapshot.browserProfileHomes;
const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;
const selectIdentity = (snapshot: HostSnapshot) => snapshot.identityConfig;

function AgentAuthorization(props: {
  readonly deploymentId: string;
  readonly host: HostClient;
  readonly requestId: string;
}) {
  const navigation = useNavigation();
  const { host, requestId } = props;
  const profiles = useHostSelector(host, selectProfiles);
  const homes = useHostSelector(host, selectHomes);
  const machines = useHostSelector(host, selectMachines);
  const identityConfig = useHostSelector(host, selectIdentity);
  const browser = agentBrowserOptions({
    browserProfiles: profiles,
    ...(homes === undefined ? {} : { browserProfileHomes: homes }),
    machines,
  });
  const home = agentHomeName({ machines, identityConfig });
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const grantsAvailable = load.kind === "ready" && load.consent.grantsAvailable === true;
  const [label, setLabel] = useState("");
  const [pickedMode, setMode] = useState<ThreadAccessMode>("approval-required");
  const [draft, setDraft] = useState<AgentGrantDraft | null>(null);
  const [sheet, setSheet] = useState<AgentGrantSheet | null>(null);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The Home refused an approval because who the agent is changed: it was read again.
  const [changed, setChanged] = useState(false);
  // A retried approval reuses the profile the first attempt created.
  const createdProfile = useRef<string | null>(null);
  const mounted = useRef(true);
  // A work Home's ceiling is known before any choice is offered, so none is offered then refused.
  const workPolicy = useWorkPolicy(host);
  const apps = useAgentAppOptions(host, sheet === "apps");
  const plugins = useAgentPluginOptions(host, sheet === "plugins");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    void host.rpc["connections.authorization.get"]({ requestId }, { signal: controller.signal })
      .then(unwrapRpcResult)
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "ready", consent: result });
        setLabel((current) => current || agentClaim(result.clientName, 120));
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(
          classifyClientFailure(failure).code === "not_found"
            ? { kind: "expired" }
            : { kind: "failed" },
        );
      });
    return () => controller.abort();
  }, [attempt, host, requestId]);

  const canCreate = browser.homes === null || browser.homes.length > 0;
  const picked: AgentGrantDraft = draft ?? {
    scope: "selected",
    tasks: false,
    resources: [],
    newProfile: canCreate ? { homeRunnerId: browser.defaultHome } : null,
  };
  // A newer policy version can rule out what was picked; Allow asks only for what it allows.
  const { draft: chosen, mode } = withinWorkPolicy({ draft: picked, mode: pickedMode }, workPolicy);
  const close = () => navigation.goBack();
  const decide = async (approve: boolean) => {
    if (load.kind !== "ready" || busy !== null || (approve && !label.trim())) return;
    const { consent } = load;
    setBusy(approve ? "allow" : "deny");
    setError(null);
    setChanged(false);
    try {
      let grant;
      if (approve && grantsAvailable) {
        if (chosen.scope === "selected" && chosen.newProfile && !createdProfile.current) {
          try {
            createdProfile.current = await createDedicatedProfile(host, {
              name: label,
              homeRunnerId: chosen.newProfile.homeRunnerId,
            });
          } catch {
            if (!mounted.current) return;
            setBusy(null);
            setError(agentWords("consent.error.newProfile"));
            return;
          }
        }
        grant = grantFromDraft(
          chosen,
          chosen.scope === "selected" && chosen.newProfile
            ? (createdProfile.current ?? undefined)
            : undefined,
        );
      }
      const completion = await answerAgentConnection(
        host,
        consent,
        approve
          ? { kind: "approve", label, accessMode: mode, ...(grant ? { grant } : {}) }
          : { kind: "deny" },
      );
      // The browser finishes the redirect back to the agent, unless another
      // request has replaced this one meanwhile: that answer is not on screen.
      if (!mounted.current) return;
      await Linking.openURL(completion);
      if (mounted.current) close();
    } catch (failure) {
      if (!mounted.current) return;
      if (approve && consentVerificationChanged(failure)) {
        await reviewAgain(consent.requestId);
        return;
      }
      setBusy(null);
      const classified = classifyClientFailure(failure);
      if (classified.code === "conflict") setLoad({ kind: "answered" });
      else if (classified.code === "not_found") setLoad({ kind: "expired" });
      // A lost answer may have decided it; only a refusal says it didn't.
      else
        setError(
          agentWords(
            classified.kind === "rejection"
              ? approve
                ? "consent.error.approve"
                : "consent.error.deny"
              : approve
                ? "consent.error.approveUnknown"
                : "consent.error.denyUnknown",
          ),
        );
    }
  };

  /** Shows the consent as the Home now presents it, keeping the choices it still offers. */
  async function reviewAgain(id: string) {
    try {
      const fresh = unwrapRpcResult(
        await host.rpc["connections.authorization.get"]({ requestId: id }),
      );
      if (!mounted.current) return;
      setLoad({ kind: "ready", consent: fresh });
      setDraft((current) => current && draftForCatalog(current, fresh));
      setChanged(true);
    } catch (failure) {
      if (!mounted.current) return;
      setLoad(
        classifyClientFailure(failure).code === "not_found"
          ? { kind: "expired" }
          : { kind: "failed" },
      );
    }
    setBusy(null);
  }

  if (load.kind === "loading" || (load.kind === "ready" && workPolicy === undefined))
    return <AgentAuthorizationForm kind="loading" />;
  if (load.kind !== "ready")
    return (
      <AgentAuthorizationForm
        kind="failed"
        onClose={close}
        {...(load.kind === "expired"
          ? {
              title: agentWords("consent.edge.expired.title"),
              detail: agentWords("consent.edge.expired.detailUnnamed"),
              onRetry: null,
            }
          : load.kind === "answered"
            ? {
                title: agentWords("consent.edge.answered.title"),
                detail: agentWords("consent.edge.answered.detail"),
                onRetry: null,
              }
            : {
                title: agentWords("consent.edge.failed.title"),
                detail: agentWords("consent.edge.failed.detail"),
                onRetry: () => setAttempt((n) => n + 1),
              })}
      />
    );
  const { consent } = load;
  const identity = connectedAgentIdentity(
    {
      label,
      clientName: consent.clientName,
      ...(consent.identity ? { identity: consent.identity } : {}),
      ...(consent.identityAtConsent ? { identityAtConsent: consent.identityAtConsent } : {}),
    },
    consent.redirectUri,
  );
  const who = identity.who;
  const heading = agentConsentHeading(who);
  // The Home's verified name is a name; with none, Opensteer's own words for it.
  const agent: SentencePart = heading.mark ? { name: heading.title } : workWords("who.thisAgent");
  const disabled = busy !== null;
  const context = {
    agent,
    home,
    browser,
    chromeTabs: consent,
    apps,
    plugins,
    disabled,
    ...(workPolicy ? { workPolicy } : {}),
  };
  const openDevices = () => {
    setSheet(null);
    navigation.navigate("SettingsDevices", { deploymentId: props.deploymentId });
  };
  return (
    <>
      <AgentAuthorizationForm
        kind="ready"
        busy={busy}
        destination={who.verified ? null : connectionDestination(consent.redirectUri)}
        error={error}
        finePrint={
          grantsAvailable
            ? phoneSentence(agentSentence("consent.finePrint", { agent }))
            : agentAuthorizationFinePrint
        }
        label={label}
        mark={
          heading.mark
            ? { providerId: identity.providerId, initial: Array.from(heading.title)[0] ?? "A" }
            : null
        }
        mode={mode}
        // A connected agent's work never runs with the person's engine settings,
        // so each mode reads as it does for a connection.
        modes={accessModeOptions.map((option) => ({
          ...option,
          description: connectionModeDescriptions[option.mode],
        }))}
        notice={changed ? agentWords("consent.error.verificationChanged") : null}
        onAllow={() => void decide(true)}
        onDeny={() => void decide(false)}
        onLabel={setLabel}
        onMode={setMode}
        sections={
          grantsAvailable
            ? [
                ...agentGrantSections({
                  ...context,
                  draft: chosen,
                  mode,
                  onScope: (scope) => setDraft({ ...chosen, scope }),
                  onOpen: setSheet,
                  onChromeTab: (resource, on) =>
                    setDraft(toggleDraftResource(chosen, resource, on)),
                  onTasks: (tasks) => setDraft({ ...chosen, tasks }),
                }),
                agentModeSection({
                  mode,
                  disabled,
                  onMode: setMode,
                  workPolicy: workPolicy ?? undefined,
                }),
              ]
            : null
        }
        title={heading.title}
        work={workHomeMark(workPolicy)?.badge ?? null}
        who={{
          heading: heading.claim ?? workWords("who.verified"),
          origins: who.verified
            ? who.origins.map((origin) => phoneSentence(agentWhoOriginParts(origin)))
            : [],
          verified: who.verified,
          warning: who.warning,
        }}
      />
      {sheet === null || !grantsAvailable ? null : (
        <AgentGrantSheetPage
          context={context}
          draft={chosen}
          onChange={setDraft}
          onClose={() => setSheet(null)}
          onOpenDevices={openDevices}
          sheet={sheet}
        />
      )}
    </>
  );
}
