import {
  accessModeOptions,
  answerAgentConnection,
  connectionDestination,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import type { ThreadAccessMode } from "@opensteer/core";
import type { AgentConnectionConsent } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Linking } from "react-native";
import { AgentAuthorizationForm } from "./agent-authorization-form.js";
import { agentAuthorizationEverything } from "./agent-authorization-form.types.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { agentConnectionExpired, agentConnectionFailure } from "./external-agents-model.js";

type Props = StaticScreenProps<{ readonly deploymentId: string; readonly requestId: string }>;

/** An agent asking to use Opensteer, opened from the link its sign-in page hands this phone. */
export function AgentAuthorizationScreen({ route }: Props): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <AgentAuthorization
      key={route.params.requestId}
      host={host}
      requestId={route.params.requestId}
    />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

function AgentAuthorization(props: { readonly host: HostClient; readonly requestId: string }) {
  const navigation = useNavigation();
  const [attempt, setAttempt] = useState(0);
  const [consent, setConsent] = useState<AgentConnectionConsent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<ThreadAccessMode>("approval-required");
  const [reach, setReach] = useState("user");
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { host, requestId } = props;
  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    void host.rpc["connections.authorization.get"]({ requestId }, { signal: controller.signal })
      .then(unwrapRpcResult)
      .then((result) => {
        if (controller.signal.aborted) return;
        setConsent(result);
        setLabel(result.clientName);
        setReach(result.workspaces[0]?.id ?? "user");
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(
            agentConnectionFailure(
              failure,
              "This connection request couldn’t be loaded. Check that this phone can reach your computer, then try again.",
            ),
          );
      });
    return () => controller.abort();
  }, [attempt, host, requestId]);

  const close = () => navigation.goBack();
  const decide = (approve: boolean) => {
    if (!consent || busy !== null || (approve && !label.trim())) return;
    setBusy(approve ? "allow" : "deny");
    setError(null);
    void answerAgentConnection(
      host,
      consent,
      approve ? { kind: "approve", label, accessMode: mode, reach } : { kind: "deny" },
    )
      // The browser finishes the redirect back to the agent.
      .then((completion) => Linking.openURL(completion))
      .then(() => {
        if (mounted.current) close();
      })
      .catch((failure: unknown) => {
        if (!mounted.current) return;
        setBusy(null);
        setError(
          agentConnectionFailure(
            failure,
            approve
              ? "The connection couldn’t be approved. Try again."
              : "The request couldn’t be denied. Try again.",
          ),
        );
      });
  };

  if (consent === null)
    return (
      <AgentAuthorizationForm
        {...(loadError === null
          ? { kind: "loading" }
          : {
              kind: "failed",
              detail: loadError,
              onClose: close,
              onRetry: loadError === agentConnectionExpired ? null : () => setAttempt((n) => n + 1),
            })}
      />
    );
  return (
    <AgentAuthorizationForm
      kind="ready"
      busy={busy}
      destination={connectionDestination(consent.redirectUri)}
      error={error}
      label={label}
      mode={mode}
      modes={accessModeOptions}
      onAllow={() => decide(true)}
      onDeny={() => decide(false)}
      onLabel={setLabel}
      onMode={setMode}
      onReach={setReach}
      reach={reach}
      reaches={[...consent.workspaces, { id: "user", name: agentAuthorizationEverything }]}
      title={`Allow ${consent.clientName} to use Opensteer?`}
    />
  );
}
