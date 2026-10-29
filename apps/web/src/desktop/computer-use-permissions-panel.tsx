import type { ComputerUsePermissions } from "@opensteer/protocol";
import {
  computerUseHelperName,
  macosAccessibilityLabel,
  macosScreenRecordingLabel,
} from "@opensteer/client/integrations";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/icon.js";

const pollIntervalMs = 1_000;
const doneLingerMs = 1_400;

/** Everything the panel needs; it never talks to a Host. */
export interface ComputerUsePermissionsPanelBridge {
  readonly closeComputerUsePermissionsPanel: () => Promise<unknown>;
  readonly computerUsePermissionsGet: () => Promise<ComputerUsePermissions>;
  readonly computerUsePermissionsRequest: (input: {
    readonly pane: Grant;
  }) => Promise<ComputerUsePermissions>;
  readonly computerUseOpenSystemSettings: (input: {
    readonly pane: "accessibility" | "screen-recording";
  }) => Promise<unknown>;
}

type Grant = "screen-recording" | "accessibility";
type Failure =
  | { readonly kind: "check"; readonly message: string }
  | { readonly kind: "request" | "settings"; readonly pane: Grant; readonly message: string };

const grants: readonly {
  readonly key: Grant;
  readonly label: string;
  readonly why: string;
  readonly field: keyof ComputerUsePermissions;
}[] = [
  {
    field: "screenRecording",
    key: "screen-recording",
    label: macosScreenRecordingLabel,
    why: "Lets agents see apps",
  },
  {
    field: "accessibility",
    key: "accessibility",
    label: macosAccessibilityLabel,
    why: "Lets agents operate apps",
  },
];

/**
 * The small window the desktop floats over System Settings while the person
 * grants the two macOS permissions that computer use needs.
 *
 * Both grants belong to `Opensteer Computer Use`, a separate helper. The
 * person starts each request explicitly, in order. If macOS still reports the
 * grant as off, the panel offers its exact System Settings pane.
 */
export function ComputerUsePermissionsPanel({
  bridge,
}: {
  readonly bridge: ComputerUsePermissionsPanelBridge;
}) {
  const [permissions, setPermissions] = useState<ComputerUsePermissions | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [awaiting, setAwaiting] = useState<Grant | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const mounted = useRef(false);
  const readingNow = useRef(false);
  const readGeneration = useRef(0);
  const requestingNow = useRef(false);
  const requestId = useRef(0);
  const granted =
    permissions?.accessibility === "granted" && permissions.screenRecording === "granted";

  useEffect(() => {
    mounted.current = true;
    document.documentElement.dataset.panel = "computer-use";
    return () => {
      mounted.current = false;
      requestId.current += 1;
      delete document.documentElement.dataset.panel;
    };
  }, []);

  const checkPermissions = useCallback(async (): Promise<ComputerUsePermissions | null> => {
    if (readingNow.current || requestingNow.current) return null;
    readingNow.current = true;
    const generation = readGeneration.current;
    try {
      const next = await bridge.computerUsePermissionsGet();
      if (!mounted.current || requestingNow.current || generation !== readGeneration.current) {
        return null;
      }
      setPermissions(next);
      setFailure((current) => {
        if (!current || current.kind === "check") return null;
        const field = current.pane === "screen-recording" ? "screenRecording" : "accessibility";
        return next[field] === "granted" ? null : current;
      });
      return next;
    } catch {
      if (!mounted.current || requestingNow.current || generation !== readGeneration.current) {
        return null;
      }
      setPermissions((current) =>
        current?.accessibility === "granted" && current.screenRecording === "granted"
          ? null
          : current,
      );
      setFailure((current) =>
        current?.kind === "request" || current?.kind === "settings"
          ? current
          : { kind: "check", message: "Opensteer could not check these permissions." },
      );
      return null;
    } finally {
      readingNow.current = false;
    }
  }, [bridge]);

  useEffect(() => {
    void checkPermissions();
    const timer = globalThis.setInterval(() => void checkPermissions(), pollIntervalMs);
    return () => globalThis.clearInterval(timer);
  }, [checkPermissions]);

  useEffect(() => {
    if (!granted) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const confirm = async () => {
      const latest = await checkPermissions();
      if (!active || !mounted.current) return;
      if (latest === null) {
        timer = globalThis.setTimeout(() => void confirm(), pollIntervalMs);
      } else if (latest.accessibility === "granted" && latest.screenRecording === "granted") {
        void bridge.closeComputerUsePermissionsPanel().catch(() => undefined);
      }
    };
    timer = globalThis.setTimeout(() => void confirm(), doneLingerMs);
    return () => {
      active = false;
      globalThis.clearTimeout(timer);
    };
  }, [bridge, checkPermissions, granted]);

  // The first grant still off is the one the panel points at.
  const next = grants.find((grant) => permissions?.[grant.field] !== "granted") ?? null;

  const requestNext = async () => {
    if (!next || requestingNow.current || requesting) return;
    const currentRequest = ++requestId.current;
    if (awaiting === next.key) {
      setRequesting(true);
      setFailure(null);
      try {
        await bridge.computerUseOpenSystemSettings({ pane: next.key });
      } catch {
        if (!mounted.current || currentRequest !== requestId.current) return;
        setFailure({
          kind: "settings",
          pane: next.key,
          message: "Opensteer could not open System Settings.",
        });
      } finally {
        if (mounted.current && currentRequest === requestId.current) setRequesting(false);
      }
      return;
    }
    readGeneration.current += 1;
    requestingNow.current = true;
    setRequesting(true);
    setFailure(null);
    try {
      const result = await bridge.computerUsePermissionsRequest({ pane: next.key });
      if (!mounted.current || currentRequest !== requestId.current) return;
      setPermissions(result);
      setAwaiting(result[next.field] === "granted" ? null : next.key);
    } catch {
      if (!mounted.current || currentRequest !== requestId.current) return;
      setFailure({
        kind: "request",
        pane: next.key,
        message: `Could not request ${next.key === "screen-recording" ? "Screen Recording" : "Accessibility"}. Try again.`,
      });
    } finally {
      if (mounted.current && currentRequest === requestId.current) {
        requestingNow.current = false;
        setRequesting(false);
      }
    }
  };

  return (
    <div className="cu-panel">
      <div className="cu-panel__head">
        <img
          alt=""
          className="cu-panel__icon"
          decoding="async"
          draggable={false}
          src="/opensteer.png"
        />
        <div className="cu-panel__titles">
          <p className="cu-panel__headline">
            {granted ? (
              <>
                <Icon name="check" />
                Computer use is ready.
              </>
            ) : (
              <>Turn on {computerUseHelperName}</>
            )}
          </p>
          {granted ? null : (
            <p className="cu-panel__sub">
              Allow each permission for <strong>{computerUseHelperName}</strong>, the helper that
              sees and operates apps on this Mac.
            </p>
          )}
        </div>
      </div>

      <ol className="cu-panel__grants">
        {grants.map((grant) => {
          const state = permissions?.[grant.field];
          const done = state === "granted";
          const current = next?.key === grant.key;
          return (
            <li
              className={`cu-panel__grant${done ? " cu-panel__grant--done" : ""}${
                current ? " cu-panel__grant--current" : ""
              }`}
              key={grant.key}
            >
              <span aria-hidden className="cu-panel__mark">
                {done ? <Icon name="check" /> : null}
              </span>
              <span className="cu-panel__grant-text">
                <span className="cu-panel__grant-label">{grant.label}</span>
                <span className="cu-panel__grant-why">
                  {done
                    ? "On"
                    : permissions === null
                      ? "Checking…"
                      : current && awaiting === grant.key
                        ? `Off · Follow the macOS prompt, or switch on ${computerUseHelperName} in System Settings.`
                        : `Off · ${grant.why}`}
                </span>
              </span>
              {current && permissions !== null ? (
                <button
                  className="btn btn--primary btn--small cu-panel__open"
                  disabled={requesting}
                  onClick={() => void requestNext()}
                  type="button"
                >
                  {requesting
                    ? awaiting === grant.key
                      ? "Opening…"
                      : "Asking macOS…"
                    : awaiting === grant.key
                      ? "Open System Settings"
                      : `Enable ${grant.key === "screen-recording" ? "Screen Recording" : "Accessibility"}`}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>

      {failure ? (
        <div className="cu-panel__error" role="alert">
          <span>{failure.message}</span>
          {failure.kind === "check" ? (
            <button
              className="btn btn--small"
              onClick={() => void checkPermissions()}
              type="button"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      {granted ? null : (
        <div className="cu-panel__actions">
          <button
            className="btn btn--ghost btn--small cu-panel__dismiss"
            onClick={() => {
              requestId.current += 1;
              readGeneration.current += 1;
              requestingNow.current = false;
              setRequesting(false);
              void bridge.closeComputerUsePermissionsPanel().catch(() => undefined);
            }}
            type="button"
          >
            Not now
          </button>
        </div>
      )}
    </div>
  );
}
