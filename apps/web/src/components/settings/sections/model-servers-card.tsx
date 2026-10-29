import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { harnessDriverLabel } from "@opensteer/core";
import type { ModelServer, ModelServerRuntime } from "@opensteer/protocol";
import { unwrapRpcResult, type EnvironmentSummary, type HostClient } from "@opensteer/client/host";
import { actionErrorMessage } from "../../../ui-utils.js";
import { Dialog } from "../../dialog.js";
import { Icon } from "../../icon.js";
import { SegmentedControl } from "../../segmented-control.js";
import { SettingsRow } from "../primitives.js";
import {
  modelServerAddress,
  modelServerConnectEngine,
  modelServerEngines,
  modelServerKey,
  modelServerName,
  modelServerRuntimeChoices,
  modelServerStateLine,
  normalizeServerAddress,
  serverAddressProblem,
  type ModelServerEngine,
} from "./model-servers.js";

/** A connected account's row, and the server it talks to. */
export interface ModelServerAccountRow {
  readonly node: ReactNode;
  readonly serverKey: string;
}

/** What Connect creates: an account of `engine` for the server at `baseUrl`. */
export interface ModelServerConnection {
  readonly baseUrl: string;
  readonly engine: ModelServerEngine;
  readonly runtime: ModelServerRuntime;
}

type Discovery =
  | { readonly kind: "looking" }
  | { readonly kind: "found"; readonly servers: readonly ModelServer[] }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Model servers on one work location: the accounts already connected to
 * them, then every server the computer has that no account uses yet. The
 * computer is asked each time the card opens, so a server started a moment
 * ago is here without anyone typing where it listens.
 */
export function ModelServersCard({
  accounts,
  client,
  connecting,
  disabled,
  environment,
  onConnect,
}: {
  readonly accounts: readonly ModelServerAccountRow[];
  readonly client: HostClient;
  /** The server whose Connect is in flight, by `modelServerKey`. */
  readonly connecting: string | null;
  /** Another change on this page is in flight. */
  readonly disabled: boolean;
  readonly environment: EnvironmentSummary;
  readonly onConnect: (connection: ModelServerConnection, onConnected: () => void) => void;
}) {
  const [discovery, setDiscovery] = useState<Discovery>({ kind: "looking" });
  const [adding, setAdding] = useState(false);
  const generation = useRef(0);
  // Only a computer the person owns runs the engines that talk to these
  // servers; a shared one reports only the ambient-free state modes.
  const ownComputer = environment.providerStateModes.includes("ambient");
  const manageable =
    ownComputer && environment.connected && environment.harnessAuthenticationAllowed;
  const environmentId = environment.id;

  const lookAgain = useCallback(() => {
    const current = ++generation.current;
    setDiscovery({ kind: "looking" });
    void client.rpc["harness.modelServers.discover"]({ environmentId })
      .then(unwrapRpcResult)
      .then(
        ({ servers }) => {
          if (current === generation.current) setDiscovery({ kind: "found", servers });
        },
        (error: unknown) => {
          if (current === generation.current) {
            setDiscovery({ kind: "failed", message: actionErrorMessage(error) });
          }
        },
      );
  }, [client, environmentId]);

  useEffect(() => {
    if (manageable) lookAgain();
    return () => {
      generation.current += 1;
    };
  }, [lookAgain, manageable]);

  if (!manageable && accounts.length === 0) return null;
  const connected = new Set(accounts.map((account) => account.serverKey));
  const found =
    discovery.kind === "found"
      ? discovery.servers.filter(
          (server) => !connected.has(modelServerKey(server.runtime, server.baseUrl)),
        )
      : [];
  const connect = (server: ModelServer) => {
    const engine = modelServerConnectEngine(environment.harnessDrivers, server.runtime);
    if (engine) {
      onConnect({ baseUrl: server.baseUrl, engine, runtime: server.runtime }, lookAgain);
    }
  };

  return (
    <section aria-labelledby="settings-model-servers" className="card settings-engine">
      {adding ? (
        <AddModelServerDialog
          busy={connecting !== null}
          client={client}
          environment={environment}
          onClose={() => setAdding(false)}
          onConnect={(connection) =>
            onConnect(connection, () => {
              setAdding(false);
              lookAgain();
            })
          }
        />
      ) : null}
      <header className="settings-engine__head">
        <span className="settings-engine__mark">
          <Icon name="server" />
        </span>
        <h2 className="settings-engine__title" id="settings-model-servers">
          Model servers
        </h2>
        {manageable ? (
          <button
            className="btn btn--small settings-engine__add"
            disabled={disabled}
            onClick={() => setAdding(true)}
            type="button"
          >
            Add a server
          </button>
        ) : null}
      </header>
      {accounts.map((account) => account.node)}
      {found.map((server) => {
        const key = modelServerKey(server.runtime, server.baseUrl);
        const engine = modelServerConnectEngine(environment.harnessDrivers, server.runtime);
        const usable = server.status === "ready" || server.status === "needs-key";
        return (
          <SettingsRow
            action={
              usable ? (
                <button
                  className="btn btn--primary btn--small"
                  disabled={disabled || engine === undefined}
                  onClick={() => connect(server)}
                  title={
                    engine ? undefined : "Pi can't run here. Add the server with another engine."
                  }
                  type="button"
                >
                  {connecting === key ? "Connecting…" : "Connect"}
                </button>
              ) : (
                <button
                  className="btn btn--small"
                  disabled={discovery.kind === "looking"}
                  onClick={lookAgain}
                  type="button"
                >
                  Look again
                </button>
              )
            }
            className="settings-account settings-model-server"
            detail={
              <span className="settings-account__facts">
                <span className="settings-account__line">{modelServerStateLine(server)}</span>
                <span className="settings-account__origin">
                  {modelServerAddress(server.baseUrl)} on {environment.name}
                </span>
              </span>
            }
            icon="server"
            key={key}
            title={
              <>
                {modelServerName(server.runtime)}
                {server.status === "not-running" ? (
                  <span className="chip chip--warn">Not running</span>
                ) : server.status === "unavailable" ? (
                  <span className="chip chip--bad">Needs attention</span>
                ) : null}
              </>
            }
          />
        );
      })}
      {manageable && discovery.kind === "looking" && found.length === 0 ? (
        <p className="card__empty card__empty--loading" role="status">
          <span className="spinner" />
          Looking for model servers on {environment.name}…
        </p>
      ) : null}
      {manageable && discovery.kind === "failed" ? (
        <div className="card__empty settings-model-servers__empty" role="alert">
          <p>{discovery.message}</p>
          <button className="btn btn--small" onClick={lookAgain} type="button">
            Look again
          </button>
        </div>
      ) : null}
      {manageable &&
      discovery.kind === "found" &&
      discovery.servers.length === 0 &&
      accounts.length === 0 ? (
        <div className="card__empty settings-model-servers__empty">
          <p>
            No model servers on {environment.name} yet. Ollama, LM Studio and oMLX appear here once
            they're installed.
          </p>
          <button className="btn btn--small" onClick={lookAgain} type="button">
            Look again
          </button>
        </div>
      ) : null}
    </section>
  );
}

type Check =
  | { readonly kind: "idle" }
  | { readonly kind: "checking"; readonly address: string }
  | { readonly kind: "found"; readonly address: string; readonly server: ModelServer }
  | { readonly kind: "failed"; readonly address: string; readonly message: string };

/**
 * A server on another computer, or one this computer runs somewhere its app
 * does not say: the person types where it is, the work location's computer
 * asks it what it is, and only a server that answered can be connected.
 */
function AddModelServerDialog({
  busy,
  client,
  environment,
  onClose,
  onConnect,
}: {
  readonly busy: boolean;
  readonly client: HostClient;
  readonly environment: EnvironmentSummary;
  readonly onClose: () => void;
  readonly onConnect: (connection: ModelServerConnection) => void;
}) {
  const [address, setAddress] = useState("");
  const [touched, setTouched] = useState(false);
  const [check, setCheck] = useState<Check>({ kind: "idle" });
  // Only a server that did not say what it is can be named by the person.
  const [named, setNamed] = useState<ModelServerRuntime>("generic");
  const [engineKind, setEngineKind] = useState<string | null>(null);
  const baseUrl = normalizeServerAddress(address);
  const problem = touched && address.trim() !== "" ? serverAddressProblem(address) : null;
  // A different address is a different question; the last answer no longer applies.
  const current = check.kind !== "idle" && check.address === baseUrl ? check : null;
  const server = current?.kind === "found" ? current.server : null;
  const runtime = server ? (server.runtime === "generic" ? named : server.runtime) : null;
  const engines = runtime ? modelServerEngines(environment.harnessDrivers, runtime) : [];
  const engine = engines.find((candidate) => candidate.driverKind === engineKind) ?? engines[0];
  const connectable =
    server !== null &&
    runtime !== null &&
    engine !== undefined &&
    (server.status === "ready" || server.status === "needs-key");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || current?.kind === "checking") return;
    if (connectable && runtime) {
      onConnect({ baseUrl, engine, runtime });
      return;
    }
    setTouched(true);
    if (serverAddressProblem(address) !== null) return;
    setCheck({ address: baseUrl, kind: "checking" });
    setNamed("generic");
    void client.rpc["harness.modelServers.discover"]({
      address: baseUrl,
      environmentId: environment.id,
    })
      .then(unwrapRpcResult)
      .then(
        ({ servers }) => {
          const answer = servers[0];
          setCheck(
            answer
              ? { address: baseUrl, kind: "found", server: answer }
              : { address: baseUrl, kind: "failed", message: "The server did not answer." },
          );
        },
        (error: unknown) =>
          setCheck({ address: baseUrl, kind: "failed", message: actionErrorMessage(error) }),
      );
  };

  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" disabled={busy} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || current?.kind === "checking" || address.trim() === ""}
            form="add-model-server-form"
            type="submit"
          >
            {connectable
              ? busy
                ? "Connecting…"
                : "Connect"
              : current?.kind === "checking"
                ? "Checking…"
                : "Check"}
          </button>
        </>
      }
      labelledBy="add-model-server-title"
      onClose={onClose}
      title="Add a model server"
    >
      <form className="add-account" id="add-model-server-form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Address</span>
          <input
            aria-invalid={problem !== null}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            className="text-input"
            disabled={busy}
            inputMode="url"
            onBlur={() => {
              if (address.trim() === "") return;
              setTouched(true);
              if (serverAddressProblem(address) === null) setAddress(baseUrl);
            }}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="192.168.1.20:11434"
            spellCheck={false}
            // Not type="url": the browser would refuse "localhost:11434",
            // which is how servers print their own address.
            type="text"
            value={address}
          />
          <span className="field__hint">
            {problem ??
              `${environment.name} connects to it, so localhost is that computer. Servers installed there are found without an address.`}
          </span>
        </label>
        {current?.kind === "failed" ? (
          <div className="notice notice--error" role="alert">
            {current.message}
          </div>
        ) : null}
        {server ? (
          <div
            className={`notice${server.status === "unavailable" ? " notice--error" : ""}`}
            role="status"
          >
            {server.runtime === "generic"
              ? `Found a server. ${modelServerStateLine(server)}`
              : `Found ${modelServerName(server.runtime)}. ${modelServerStateLine(server)}`}
          </div>
        ) : null}
        {server?.runtime === "generic" && server.status !== "unavailable" ? (
          <label className="field">
            <span className="field__label">Server</span>
            <select
              className="select-input"
              disabled={busy}
              onChange={(event) => setNamed(event.target.value as ModelServerRuntime)}
              value={named}
            >
              {modelServerRuntimeChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
            <span className="field__hint">
              It didn't say which server it is. Naming it lets Opensteer read each model's context
              size.
            </span>
          </label>
        ) : null}
        {connectable && engines.length > 1 ? (
          <div className="field">
            <span className="field__label">Runs with</span>
            <SegmentedControl
              ariaLabel="Runs with"
              className="settings-model-servers__choice"
              disabled={busy}
              onChange={setEngineKind}
              options={engines.map((candidate) => ({
                label: harnessDriverLabel(candidate.driverKind),
                value: candidate.driverKind,
              }))}
              value={engine.driverKind}
            />
            <span className="field__hint">
              Pi can be steered while it works; OpenCode can stop to ask you a question.
            </span>
          </div>
        ) : connectable ? (
          <p className="form-hint">Runs with {harnessDriverLabel(engine.driverKind)}.</p>
        ) : null}
      </form>
    </Dialog>
  );
}
