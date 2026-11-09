import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type {
  AccountSignInFlow,
  AccountSignInState,
  HarnessAuthenticationView,
} from "@opensteer/client/host";
import type { HarnessSetupMethod, HostApiCommandInput } from "@opensteer/protocol";
import { copyText } from "@opensteer/shared/clipboard";
import { actionErrorMessage } from "../ui-utils.js";
import { Dialog } from "./dialog.js";
import { ExternalLink } from "./external-link.js";
import { Icon } from "./icon.js";

const copiedDwellMs = 2_000;

/** What adding an account takes: the account to create and how to talk about it. */
export interface AddHarnessAccount {
  readonly continued?: boolean;
  /** The way in to use, when the caller already knows it. */
  readonly selectMethod?: (methods: readonly HarnessSetupMethod[]) => string | undefined;
  readonly request: Extract<HostApiCommandInput, { readonly type: "harness.create" }>;
  readonly title: string;
  readonly whereLabel: string;
}

type PendingView = Extract<HarnessAuthenticationView, { readonly kind: "pending" }>;

function alternativeLabel(method: HarnessSetupMethod): string {
  return method.kind === "secret-input" ? "Use an API key instead" : `Use ${method.label} instead`;
}

/**
 * Every way into an AI account, drawn from one flow: a code to enter, a page
 * that hands one back, or a key to paste. It only draws what the flow reports,
 * so web and mobile cannot disagree about what happens next.
 */
export function AccountSignInDialog({
  continued = false,
  flow,
  onClose,
  onDone,
  title,
  whereLabel,
}: {
  /** Follows another dialog, so it appears without entering again. */
  readonly continued?: boolean;
  readonly flow: AccountSignInFlow;
  readonly onClose: () => void;
  readonly onDone: (state: Extract<AccountSignInState, { readonly kind: "done" }>) => void;
  readonly title: string;
  readonly whereLabel: string;
}) {
  const state = useSyncExternalStore(flow.subscribe, flow.getState);
  const signingIn = state.kind === "signing-in" ? state : null;
  const method = signingIn?.methods.find(({ methodId }) => methodId === signingIn.methodId) ?? null;
  const view = signingIn?.session?.view ?? null;
  const pending = view?.kind === "pending" ? view : null;
  const code = pending && pending.inputPrompt === undefined ? pending.userCode : null;

  const [opened, setOpened] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const codeRef = useRef<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLAnchorElement | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const methodId = signingIn?.methodId ?? null;
  useEffect(() => {
    setOpened(false);
    setOpenError(null);
    setValue("");
  }, [methodId]);
  useEffect(() => {
    setCopy("idle");
  }, [code]);
  useEffect(() => {
    if (pending && !opened) primaryRef.current?.focus({ preventScroll: true });
  }, [pending === null, opened]);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const settled = useRef(false);
  useEffect(() => {
    if (settled.current) return;
    if (state.kind === "done") {
      settled.current = true;
      onDone(state);
    } else if (state.kind === "cancelled") {
      settled.current = true;
      onClose();
    }
  }, [onClose, onDone, state]);

  const copyCode = (text: string) => {
    void copyText(text).then((copied) => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      setCopy(copied ? "copied" : "failed");
      if (copied) {
        copiedTimer.current = setTimeout(() => setCopy("idle"), copiedDwellMs);
      } else if (codeRef.current) {
        globalThis.getSelection?.()?.selectAllChildren(codeRef.current);
      }
    });
  };
  const submit = () => {
    if (!pending || value.length === 0 || submitting) return;
    setSubmitting(true);
    void flow
      .submit(value)
      .then(() => setValue(""))
      .finally(() => setSubmitting(false));
  };
  const openPage = (url: string, label: string, primary: boolean, onOpen?: () => void) => (
    <ExternalLink
      className={primary ? "btn btn--primary" : "btn"}
      href={url}
      onOpen={() => {
        onOpen?.();
        setOpened(true);
        setOpenError(null);
      }}
      onOpenError={(reason) => setOpenError(actionErrorMessage(reason))}
      {...(primary ? { ref: primaryRef } : {})}
    >
      {label}
      <Icon name="external-link" />
    </ExternalLink>
  );

  const cancel = (
    <button className="btn btn--ghost" onClick={onClose} type="button">
      Cancel
    </button>
  );
  const alternatives = signingIn?.methods
    .filter((candidate) => candidate.methodId !== signingIn.methodId)
    .map((candidate) => (
      <button
        className="btn btn--ghost account-sign-in__alternative"
        key={candidate.methodId}
        onClick={() => flow.chooseMethod(candidate.methodId)}
        type="button"
      >
        {alternativeLabel(candidate)}
      </button>
    ));

  let body: ReactNode;
  let footer: ReactNode = cancel;
  const failure = signingIn?.error ?? (view?.kind === "failed" ? view.detail : null);

  if (state.kind === "finishing") {
    footer = null;
    body = <Status>Signed in. Finishing up…</Status>;
  } else if (state.kind === "duplicate") {
    footer = (
      <>
        <button className="btn btn--ghost" onClick={() => flow.keepDuplicate()} type="button">
          Keep both
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void flow.removeDuplicate()}
          type="button"
        >
          Remove this one
        </button>
      </>
    );
    body = (
      <div className="notice notice--warn" role="status">
        {state.accountLabel} is already added. Your browser may have used that account.
      </div>
    );
  } else if (state.kind === "failed") {
    footer = (
      <>
        {cancel}
        <button className="btn btn--primary" onClick={() => flow.retry()} type="button">
          Try again
        </button>
      </>
    );
    body = (
      <div className="notice notice--error" role="alert">
        {state.message}
      </div>
    );
  } else if (view?.kind === "disconnected") {
    body = (
      <div className="notice notice--warn" role="status">
        {whereLabel} is offline. Sign-in continues when it’s back.
      </div>
    );
  } else if (failure !== null && !pending && method?.kind !== "secret-input") {
    footer = (
      <>
        {alternatives}
        {cancel}
        <button className="btn btn--primary" onClick={() => flow.retry()} type="button">
          Try again
        </button>
      </>
    );
    body = (
      <div className="notice notice--error" role="alert">
        {failure}
      </div>
    );
  } else if (method?.kind === "secret-input") {
    const placeholder = method.inputPlaceholder;
    footer = (
      <>
        {alternatives}
        {cancel}
        <button
          className="btn btn--primary"
          disabled={!pending || value.length === 0 || submitting}
          form="account-sign-in-form"
          type="submit"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
      </>
    );
    body = (
      <form
        className="account-sign-in__form"
        id="account-sign-in-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {failure !== null ? (
          <div className="notice notice--error" role="alert">
            {failure}
          </div>
        ) : null}
        <label className="field">
          <span className="field__label">{pending?.inputPrompt ?? method.inputLabel}</span>
          <input
            autoComplete="off"
            autoFocus
            className="text-input"
            disabled={submitting}
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
            type="password"
            value={value}
            {...(placeholder ? { placeholder } : {})}
          />
          <span className="field__hint">Stored only on {whereLabel}.</span>
        </label>
      </form>
    );
  } else if (pending && code !== null) {
    body = (
      <DeviceCode
        code={code}
        codeRef={codeRef}
        copy={copy}
        onCopy={() => copyCode(code)}
        opened={opened}
        openError={openError}
        view={pending}
      />
    );
    footer = (
      <>
        {alternatives}
        {cancel}
        {pending.verificationUrl
          ? opened
            ? openPage(pending.verificationUrl, "Open browser again", false)
            : openPage(pending.verificationUrl, "Copy code and open browser", true, () =>
                copyCode(code),
              )
          : null}
      </>
    );
  } else if (pending) {
    footer = (
      <>
        {alternatives}
        {cancel}
        {pending.verificationUrl
          ? opened
            ? openPage(pending.verificationUrl, "Open again", false)
            : openPage(pending.verificationUrl, "Open sign-in page", true)
          : null}
        {opened || !pending.verificationUrl ? (
          <button
            className="btn btn--primary"
            disabled={value.length === 0 || submitting}
            form="account-sign-in-form"
            type="submit"
          >
            {submitting ? "Submitting…" : "Submit"}
          </button>
        ) : null}
      </>
    );
    body = (
      <form
        className="account-sign-in__form"
        id="account-sign-in-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="account-sign-in__lead">Sign in on the page that opens.</p>
        {failure !== null || openError !== null ? (
          <div className="notice notice--error" role="alert">
            {failure ?? openError}
          </div>
        ) : null}
        <label className="field">
          <span className="field__label">{pending.inputPrompt}</span>
          <input
            autoComplete="one-time-code"
            className="text-input"
            disabled={submitting}
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
            type="text"
            value={value}
          />
        </label>
      </form>
    );
  } else {
    if (signingIn) {
      footer = (
        <>
          {alternatives}
          {cancel}
        </>
      );
    }
    body = (
      <div
        aria-busy="true"
        aria-label="Getting ready"
        className="account-sign-in__code"
        role="status"
      >
        <span className="skeleton account-sign-in__skeleton" />
      </div>
    );
  }

  return (
    <Dialog
      continued={continued}
      footer={footer}
      labelledBy="account-sign-in-title"
      onClose={onClose}
      title={title}
    >
      <div className="account-sign-in">{body}</div>
    </Dialog>
  );
}

function Status({ children }: { readonly children: ReactNode }) {
  return (
    <p className="account-sign-in__status" role="status">
      <span aria-hidden className="spinner" />
      {children}
    </p>
  );
}

function DeviceCode({
  code,
  codeRef,
  copy,
  onCopy,
  opened,
  openError,
  view,
}: {
  readonly code: string;
  readonly codeRef: React.RefObject<HTMLElement | null>;
  readonly copy: "idle" | "copied" | "failed";
  readonly onCopy: () => void;
  readonly opened: boolean;
  readonly openError: string | null;
  readonly view: PendingView;
}) {
  return (
    <>
      <p className="account-sign-in__lead">Enter this code on the page that opens.</p>
      <div className="account-sign-in__code">
        <code aria-label="One-time code" ref={codeRef}>
          {code}
        </code>
        <button
          className={`btn btn--small account-sign-in__copy${copy === "copied" ? " is-copied" : ""}`}
          onClick={onCopy}
          type="button"
        >
          <Icon name={copy === "copied" ? "check" : "copy"} />
          {copy === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      {copy === "failed" ? (
        <p className="account-sign-in__warning" role="alert">
          Couldn’t copy. Select the code and copy it yourself.
        </p>
      ) : null}
      {view.codeReplaced ? (
        <div className="notice notice--warn" role="status">
          You have a new code. Use this one.
        </div>
      ) : null}
      {openError !== null ? (
        <div className="notice notice--error" role="alert">
          {openError}
        </div>
      ) : null}
      {opened ? <Status>Waiting for you to finish in your browser…</Status> : null}
    </>
  );
}
