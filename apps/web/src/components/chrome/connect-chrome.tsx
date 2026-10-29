import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  chromeConnectOrigins,
  chromeConnectPageUrl,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import type {
  BrowserSourcePairing,
  BrowserSourceSummary,
} from "@opensteer/protocol/browser-sources";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";
import type { ChromeConnectEnvironment } from "./chrome-environment.js";

export type ConnectChromeClient = Pick<HostClient, "dispatch" | "rpc">;

const extensionsPage = "chrome://extensions";
const probeEveryMs = 1_500;
const pollEveryMs = 2_000;

type Stage =
  | { readonly kind: "detecting" }
  | { readonly kind: "install" }
  | { readonly kind: "ready"; readonly detected: boolean }
  | { readonly kind: "working" }
  | {
      readonly kind: "waiting";
      /** The link a person can open themselves when no tab could be opened for them. */
      readonly link: string | null;
      readonly retry: (() => void) | null;
    }
  | { readonly kind: "expired" }
  | { readonly kind: "handed-off" }
  | { readonly kind: "connected"; readonly name: string };

/**
 * Connecting Chrome, wherever it starts: Settings, a sign-in card, the browser
 * toolbar, or the public page a link opens. It installs the extension when it
 * is missing, hands the one-use link to the extension's own connect tab, and
 * says Connected once the new Chrome appears.
 *
 * `client` is null only on the public page, which already holds its link and
 * cannot see the Deployment: it hands off and tells the person to go back.
 */
export function ConnectChrome({
  client,
  compact = false,
  environment,
  intro = null,
  invitation = null,
  onConnected,
}: {
  readonly client: ConnectChromeClient | null;
  readonly compact?: boolean;
  readonly environment: ChromeConnectEnvironment;
  /** Says why Chrome is needed, above the button; the install steps carry their own. */
  readonly intro?: string | null;
  readonly invitation?: string | null;
  readonly onConnected?: (source: BrowserSourceSummary) => void;
}) {
  const [stage, setStage] = useState<Stage>(() =>
    environment.place === "chromium" ? { kind: "detecting" } : { detected: false, kind: "ready" },
  );
  const [error, setError] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState<ElsewhereState>({ kind: "idle" });
  const known = useRef<ReadonlySet<string> | null>(null);
  const [watchUntil, setWatchUntil] = useState<number | null>(null);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const headingId = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);

  // Detection runs until the extension answers, so installing it in another
  // tab moves this one on by itself.
  const probing = stage.kind === "detecting" || stage.kind === "install";
  useEffect(() => {
    if (!probing) return;
    let active = true;
    let timer: number | undefined;
    const probe = async () => {
      const found = await environment.probeExtension();
      if (!active) return;
      if (found) {
        setStage((current) => ({
          detected: current.kind === "install",
          kind: "ready",
        }));
        return;
      }
      setStage((current) => (current.kind === "detecting" ? { kind: "install" } : current));
      timer = window.setTimeout(() => void probe(), probeEveryMs);
    };
    void probe();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [environment, probing]);

  // The extension pairs with the Host directly; the only sign here is a new
  // Chrome in the list. A Chrome that was already connected re-pairs and
  // retires its old connection in the same step, so success is a new id
  // appearing, whatever else left the list.
  useEffect(() => {
    if (!client || watchUntil === null) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (Date.now() > watchUntil) {
        window.clearInterval(timer);
        setWatchUntil(null);
        setStage((current) => (current.kind === "waiting" ? { kind: "expired" } : current));
        return;
      }
      void client.rpc["browser.sources.get"]({})
        .then(unwrapRpcResult)
        .then((state) => {
          if (!active) return;
          const added = state.sources.find((source) => !known.current?.has(source.id));
          if (!added) return;
          active = false;
          window.clearInterval(timer);
          setWatchUntil(null);
          setElsewhere({ kind: "idle" });
          setStage({ kind: "connected", name: added.name });
          onConnectedRef.current?.(added);
        })
        .catch(() => undefined);
    }, pollEveryMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, watchUntil]);

  useEffect(() => {
    if (stage.kind === "connected" || (stage.kind === "ready" && stage.detected)) {
      statusRef.current?.focus();
    }
  }, [stage]);

  /** Every action pairs afresh: a link is one-use and short-lived, so none is kept. */
  const pair = useCallback(async (): Promise<BrowserSourcePairing> => {
    if (!client) throw new Error("Go back to Opensteer and choose Connect Chrome again.");
    if (!known.current) {
      const state = unwrapRpcResult(await client.rpc["browser.sources.get"]({}));
      known.current = new Set(state.sources.map((source) => source.id));
    }
    const result = await client.dispatch({
      idempotencyKey: mutationIdempotencyKey("browser-source-pair"),
      type: "browser.source.pair",
    });
    if (result.type !== "browser.source.pair") throw new Error("Opensteer answered unexpectedly.");
    setWatchUntil(Date.parse(result.pairing.expiresAt));
    return result.pairing;
  }, [client]);

  const connect = async () => {
    setError(null);
    // The public page already holds its link and hands it straight over.
    if (!client) {
      if (!invitation) return;
      if (environment.openExtensionConnect(invitation)) {
        setStage({ kind: "handed-off" });
      } else {
        setError("Chrome blocked the tab. Allow pop-ups for this page, then try again.");
      }
      return;
    }
    setStage({ kind: "working" });
    try {
      const pairing = await pair();
      const origin = environment.hostHere
        ? chromeConnectOrigins(pairing).here
        : (chromeConnectOrigins(pairing).elsewhere ?? chromeConnectOrigins(pairing).here);
      const pageLink = chromeConnectPageUrl(origin, pairing.invitation);
      if (environment.place === "chromium") {
        const opened = environment.openExtensionConnect(pairing.invitation);
        setStage({
          kind: "waiting",
          link: null,
          retry: opened ? null : () => environment.openExtensionConnect(pairing.invitation),
        });
      } else if (environment.place === "desktop") {
        await environment.openInDefaultBrowser(pageLink);
        setStage({ kind: "waiting", link: pageLink, retry: null });
      } else {
        const copied = await environment.copy(pageLink);
        setStage({ kind: "waiting", link: copied ? null : pageLink, retry: null });
        if (!copied) setError("Couldn’t copy. Select the link below and copy it.");
      }
    } catch (reason) {
      setError(actionErrorMessage(reason));
      setStage({ detected: false, kind: "ready" });
    }
  };

  const copyElsewhere = async () => {
    if (!client) return;
    setElsewhere({ kind: "working" });
    try {
      const pairing = await pair();
      const origins = chromeConnectOrigins(pairing);
      const origin = origins.elsewhere ?? origins.here;
      const link = chromeConnectPageUrl(origin, pairing.invitation);
      const copied = await environment.copy(link);
      setElsewhere({ copied, kind: "copied", link, remote: origins.elsewhere !== null });
    } catch (reason) {
      setElsewhere({ kind: "failed", message: actionErrorMessage(reason) });
    }
  };

  let body: ReactNode;
  switch (stage.kind) {
    case "detecting":
      body = (
        <p className="connect-chrome__status" role="status">
          <span aria-hidden className="spinner" /> Checking Chrome…
        </p>
      );
      break;
    case "install":
      body = <InstallSteps compact={compact} environment={environment} />;
      break;
    case "ready":
    case "working":
    case "expired":
      body = (
        <ReadyStep
          intro={intro}
          busy={stage.kind === "working"}
          detected={stage.kind === "ready" && stage.detected}
          expired={stage.kind === "expired"}
          onConnect={() => void connect()}
          place={environment.place}
          publicPage={client === null}
          statusRef={statusRef}
        />
      );
      break;
    case "waiting":
      body = (
        <div className="connect-chrome__waiting">
          <p className="connect-chrome__status" role="status">
            <span aria-hidden className="spinner" />
            {waitingSentence(environment.place, stage.retry !== null)}
          </p>
          {stage.retry ? (
            <button className="btn btn--small" onClick={stage.retry} type="button">
              Open the Chrome tab
            </button>
          ) : null}
          {stage.link ? (
            <>
              {environment.place === "desktop" ? (
                <p className="connect-chrome__hint">
                  If your default browser isn’t Chrome, copy this link into Chrome. It works once,
                  for 15 minutes.
                </p>
              ) : null}
              <LinkField link={stage.link} />
            </>
          ) : null}
        </div>
      );
      break;
    case "handed-off":
      body = (
        <p className="connect-chrome__status connect-chrome__status--done" role="status">
          <Icon name="check-circle" />
          Finish in the Chrome tab that opened. When it says Connected, return to Opensteer.
        </p>
      );
      break;
    case "connected":
      body = (
        <p
          className="connect-chrome__status connect-chrome__status--done"
          ref={statusRef}
          role="status"
          tabIndex={-1}
        >
          <Icon name="check-circle" />
          Connected {stage.name}.
        </p>
      );
      break;
  }

  const showElsewhere = client !== null && !compact && stage.kind !== "connected";
  return (
    <section
      aria-labelledby={compact ? undefined : headingId}
      aria-label={compact ? "Connect Chrome" : undefined}
      className={compact ? "connect-chrome connect-chrome--compact" : "connect-chrome"}
    >
      {compact ? null : (
        <h3 className="visually-hidden" id={headingId}>
          Connect Chrome
        </h3>
      )}
      {body}
      {error ? (
        <p className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      {showElsewhere ? (
        <ElsewhereRow onCopy={() => void copyElsewhere()} state={elsewhere} />
      ) : null}
    </section>
  );
}

function waitingSentence(place: ChromeConnectEnvironment["place"], blocked: boolean): string {
  if (blocked) return "Chrome blocked the tab. Open it to finish.";
  if (place === "chromium") return "Finish in the Chrome tab that opened. This updates by itself.";
  if (place === "desktop") return "Finish in Chrome. This updates by itself.";
  return "Link copied. Paste it into Chrome on this computer. This updates by itself.";
}

/* ---- Ready: one button, named for what it does here ---- */

function ReadyStep({
  busy,
  detected,
  expired,
  intro,
  onConnect,
  place,
  publicPage,
  statusRef,
}: {
  readonly busy: boolean;
  readonly detected: boolean;
  readonly expired: boolean;
  readonly intro: string | null;
  readonly onConnect: () => void;
  readonly place: ChromeConnectEnvironment["place"];
  readonly publicPage: boolean;
  readonly statusRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  if (place === "phone") {
    return (
      <p className="connect-chrome__lead">
        Connect Chrome from Opensteer on your computer. Chrome on a phone can’t share sign-ins.
      </p>
    );
  }
  if (place === "other-browser" && publicPage) {
    return (
      <p className="connect-chrome__lead">
        This step needs Chrome. Copy this page’s address and open it in Chrome on this computer.
      </p>
    );
  }
  const label =
    place === "chromium"
      ? "Connect Chrome"
      : place === "desktop"
        ? "Open in Chrome"
        : "Copy link for Chrome";
  const hint =
    place === "chromium"
      ? "Chrome opens a tab to confirm, then closes it."
      : place === "desktop"
        ? "Opens a page in your default browser. If that isn’t Chrome, paste the page’s address into Chrome."
        : "This browser can’t connect Chrome. Paste the link into Chrome on this computer.";
  return (
    <div className="connect-chrome__ready">
      {intro && !detected ? <p className="connect-chrome__lead">{intro}</p> : null}
      {detected ? (
        <p
          className="connect-chrome__status connect-chrome__status--done"
          ref={statusRef}
          role="status"
          tabIndex={-1}
        >
          <Icon name="check-circle" />
          Extension added.
        </p>
      ) : null}
      {expired ? (
        <p className="connect-chrome__status" role="status">
          That link expired. Connect again to get a new one.
        </p>
      ) : null}
      <div className="connect-chrome__action">
        <button className="btn btn--primary" disabled={busy} onClick={onConnect} type="button">
          {busy ? <span aria-hidden className="spinner" /> : null}
          {label}
        </button>
        <p className="connect-chrome__hint">{hint}</p>
      </div>
    </div>
  );
}

/* ---- Install: three steps, each with the thing it asks for ---- */

function InstallSteps({
  compact,
  environment,
}: {
  readonly compact: boolean;
  readonly environment: ChromeConnectEnvironment;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => setCopied(await environment.copy(extensionsPage));
  return (
    <div className="connect-chrome__install">
      <p className="connect-chrome__lead">
        {compact
          ? "First, add the Opensteer extension to Chrome."
          : "First, add the Opensteer extension to that Chrome."}
      </p>
      <ol className="connect-chrome__steps">
        <li className="connect-chrome__step">
          <span aria-hidden className="connect-chrome__number">
            1
          </span>
          <div className="connect-chrome__step-body">
            <p>Download the extension and unzip it.</p>
            <a className="btn btn--small" download href="/browser-extension.zip">
              <Icon name="arrow-up" className="connect-chrome__download-icon" />
              Download
            </a>
          </div>
        </li>
        <li className="connect-chrome__step">
          <span aria-hidden className="connect-chrome__number">
            2
          </span>
          <div className="connect-chrome__step-body">
            <p>Open a new tab and go to Chrome’s extensions page.</p>
            <div className="connect-chrome__omnibox">
              <code>{extensionsPage}</code>
              <button
                aria-label={`Copy ${extensionsPage}`}
                className="btn btn--small btn--ghost"
                onClick={() => void copy()}
                type="button"
              >
                <Icon name={copied ? "check" : "copy"} />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <span aria-live="polite" className="visually-hidden">
              {copied === true
                ? "Copied. Paste it into Chrome’s address bar."
                : copied === false
                  ? "Couldn’t copy. Type chrome://extensions into the address bar."
                  : ""}
            </span>
          </div>
        </li>
        <li className="connect-chrome__step">
          <span aria-hidden className="connect-chrome__number">
            3
          </span>
          <div className="connect-chrome__step-body">
            <p>
              Turn on <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>, and
              pick the unzipped folder.
            </p>
            <div aria-hidden className="connect-chrome__sketch">
              <span className="connect-chrome__sketch-button">Load unpacked</span>
              <span className="connect-chrome__sketch-toggle">
                Developer mode
                <span className="connect-chrome__sketch-switch" />
              </span>
            </div>
          </div>
        </li>
      </ol>
      <p className="connect-chrome__status" role="status">
        <span aria-hidden className="spinner" /> Looking for the extension. This moves on by itself.
      </p>
    </div>
  );
}

/* ---- Another computer or Chrome profile ---- */

type ElsewhereState =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly copied: boolean;
      readonly kind: "copied";
      readonly link: string;
      readonly remote: boolean;
    };

function ElsewhereRow({
  onCopy,
  state,
}: {
  readonly onCopy: () => void;
  readonly state: ElsewhereState;
}) {
  return (
    <div className="connect-chrome__elsewhere">
      <button
        className="connect-chrome__link"
        disabled={state.kind === "working"}
        onClick={onCopy}
        type="button"
      >
        <Icon name="copy" />
        Copy a link for Chrome on another computer or profile
      </button>
      <div aria-live="polite">
        {state.kind === "copied" ? (
          <>
            <p className="connect-chrome__hint">
              {state.copied ? "Link copied. " : "Copy this link. "}
              Open it in that Chrome within 15 minutes; it works once.
              {state.remote
                ? ""
                : " It only works on this computer. To connect Chrome on another computer, turn on Remote access in Settings."}
            </p>
            {state.copied ? null : <LinkField link={state.link} />}
          </>
        ) : state.kind === "failed" ? (
          <p className="connect-chrome__hint connect-chrome__hint--error" role="alert">
            {state.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LinkField({ link }: { readonly link: string }) {
  return (
    <input
      aria-label="Link for Chrome"
      className="text-input connect-chrome__link-field"
      onFocus={(event) => event.currentTarget.select()}
      readOnly
      spellCheck={false}
      value={link}
    />
  );
}
