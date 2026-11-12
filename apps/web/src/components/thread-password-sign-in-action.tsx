import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { Request } from "@opensteer/core";
import {
  browserSiteLabel,
  mutationIdempotencyKey,
  passwordSignInAccountFilterLabel,
  passwordSignInAccountList,
  passwordSignInAllowRemembers,
  passwordSignInExpiry,
  passwordSignInNoAccount,
  passwordSignInNoAccountMatch,
  passwordSignInOtherAccounts,
  passwordSignInOutcome,
  passwordSignInConsent,
  passwordSignInPrivacy,
  type HostClient,
  type PasswordSignInAccount,
  type PasswordSignInAccountGroup,
  type PasswordSignInAccountRow,
} from "@opensteer/client/host";
import type { PasswordSignInCard } from "@opensteer/protocol";
import { CardUseRequestBody } from "./thread-card-use-action.js";
import { actionErrorMessage } from "../ui-utils.js";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";

export type PasswordSignInRequestClient = Pick<HostClient, "dispatch" | "rpc">;

/** The agent wrote the reason, so it is labelled as the agent's and never as Opensteer's. */
const reasonLabel = "Agent’s reason";
/** The Mac no longer runs a sign-in whose Request the Host has not settled yet. */
const signInGone = "This sign-in is no longer running.";

/** Often enough that "Expires in" never lags the deadline by more than a moment. */
const expiryTickMs = 5_000;
/** Past this many accounts in view the list offers a filter. */
const filterAbove = 8;

/** All signed-in clients use the requester-authorized Host path. */
export function ThreadPasswordSignInAction({
  disabled,
  request,
}: {
  readonly disabled: boolean;
  readonly request: Request;
}) {
  const { hostClient } = useShell();
  return (
    <CredentialRequestBody
      client={hostClient}
      disabled={disabled}
      key={request.id}
      request={request}
    />
  );
}

function CredentialRequestBody(props: Parameters<typeof PasswordSignInRequestBody>[0]) {
  return props.request.payload.kind === "browser.password-sign-in" &&
    props.request.payload.credential === "card" ? (
    <CardUseRequestBody {...props} />
  ) : (
    <PasswordSignInRequestBody {...props} />
  );
}

type Busy = "allow" | "decline" | "once" | null;

export function PasswordSignInRequestBody({
  client,
  disabled,
  request,
}: {
  readonly client: PasswordSignInRequestClient;
  readonly disabled: boolean;
  readonly request: Request;
}) {
  const payload = request.payload.kind === "browser.password-sign-in" ? request.payload : null;
  const pending = request.status === "pending";
  const signIn = useHostSignIn(client, pending && !disabled ? request.id : null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  // One key per card: a decline whose reply was lost is retried, not repeated.
  const declineKey = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const forwardRef = useRef<HTMLButtonElement | null>(null);
  // Where the keyboard starts in a list of accounts: its filter or its first row.
  const listEntryRef = useRef<HTMLInputElement | null>(null);
  const [now, setNow] = useState(() => new Date());
  const { state } = signIn;
  const stage = state?.stage ?? null;

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(new Date()), expiryTickMs);
    return () => window.clearInterval(timer);
  }, [pending]);

  // The forward action takes focus as its stage appears, so Return answers it,
  // or the list does when there is an account to choose first, unless the
  // person is typing somewhere else.
  useEffect(() => {
    if (stage !== "approval") return;
    const active = document.activeElement;
    const typing =
      (active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement && active.type !== "radio")) &&
      !rootRef.current?.contains(active);
    if (!typing) (listEntryRef.current ?? forwardRef.current)?.focus();
  }, [stage]);

  if (!payload) return <ActionNote alert>This sign-in request is invalid.</ActionNote>;

  const outcome = passwordSignInOutcome(request);
  if (outcome) {
    return (
      <div className="sign-in-card">
        <p
          className={`sign-in-card__line${outcome.signedIn ? " sign-in-card__line--ok" : ""}`}
          role="status"
        >
          <Icon name={outcome.signedIn ? "check-circle" : "alert-circle"} />
          {outcome.text}
        </p>
      </div>
    );
  }

  const accounts: readonly PasswordSignInAccount[] =
    state?.stage === "approval" ? state.accounts : [];
  // Allow remembers the account, so of several the person always chooses one.
  const chosen =
    accounts.length === 1 ? accounts[0]! : (accounts.find(({ id }) => id === chosenId) ?? null);
  const authorized = stage === "authorized";
  const expired = new Date(payload.expiresAt).getTime() <= now.getTime();

  function decline() {
    if (busy !== null || disabled) return;
    setBusy("decline");
    setError(null);
    declineKey.current ??= mutationIdempotencyKey(`password-sign-in:${request.id}`);
    // The Request leaving the pending list is what ends the card, so a decline
    // the Host admitted stays busy until the Mac has answered it.
    client
      .dispatch({
        idempotencyKey: declineKey.current,
        requestId: request.id,
        type: "browser.password-sign-in.respond",
        decision: { kind: "decline" },
      })
      .catch((reason: unknown) => {
        setError(actionErrorMessage(reason));
        setBusy(null);
      });
  }

  function approve(remember: boolean) {
    const account = chosen;
    if (!account || busy !== null || disabled) return;
    setBusy(remember ? "allow" : "once");
    setError(null);
    client
      .dispatch({
        type: "browser.password-sign-in.respond",
        requestId: request.id,
        idempotencyKey: mutationIdempotencyKey(`password-sign-in:${request.id}`),
        decision: {
          kind: "approve",
          loginId: account.id,
          revision: account.revision,
          remember,
          permissionVersion: 6,
        },
      })
      .then((result) => {
        if (result.type !== "browser.password-sign-in.respond") return;
        if (result.card) signIn.apply(result.card);
        if (result.message) setError(result.message);
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setBusy(null));
  }

  const offer = !expired && state?.stage === "approval" && accounts.length > 0;
  const forward = offer && chosen !== null ? () => approve(true) : null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape" && stage === "approval") {
      event.preventDefault();
      decline();
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      forward !== null &&
      // A focused button or disclosure answers Return itself.
      !(event.target instanceof HTMLButtonElement) &&
      !(event.target instanceof HTMLElement && event.target.tagName === "SUMMARY")
    ) {
      event.preventDefault();
      forward();
    }
  }

  const locked = disabled || busy !== null || authorized;
  const confirming = busy === "allow" || busy === "once";

  return (
    <div className="sign-in-card" onKeyDown={onKeyDown} ref={rootRef}>
      <div className="action-field">
        <span className="eyebrow eyebrow--micro">{reasonLabel}</span>
        <span>{payload.reason}</span>
      </div>
      <div aria-live="polite" className="sign-in-card__state">
        {state === null ? null : state.stage === "approval" ? (
          accounts.length === 0 ? (
            <p className="sign-in-card__lead">{passwordSignInNoAccount(payload.site)}</p>
          ) : accounts.length === 1 && chosen ? (
            <p className="sign-in-card__lead">
              Sign in as <strong className="sign-in-card__account">{chosen.username}</strong>
              {loneAccountDetail(chosen, payload.site) ? (
                <span className="sign-in-card__problem-detail">
                  {" "}
                  · {loneAccountDetail(chosen, payload.site)}
                </span>
              ) : null}
            </p>
          ) : (
            <AccountChoice
              accounts={accounts}
              chosenId={chosen?.id ?? null}
              entryRef={listEntryRef}
              onChoose={setChosenId}
              site={payload.site}
            />
          )
        ) : state.stage === "authorized" ? (
          <p className="sign-in-card__line" role="status">
            <Icon name="check-circle" />
            Allowed agents to sign in
          </p>
        ) : (
          <ActionNote>{signInGone}</ActionNote>
        )}
      </div>
      <div className="sign-in-card__notes">
        <p>
          {chosen !== null
            ? passwordSignInConsent(payload.site, chosen.username)
            : passwordSignInPrivacy(payload.site)}
        </p>
        {offer && chosen !== null ? <p>{passwordSignInAllowRemembers(chosen.username)}</p> : null}
      </div>
      {confirming ? (
        <p className="sign-in-card__line" role="status">
          <span aria-hidden className="spinner" />
          Allowing agents to sign in…
        </p>
      ) : null}
      {signIn.readError ? (
        <div className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{signIn.readError}</span>
          <button className="btn btn--small" onClick={signIn.retry} type="button">
            Try again
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="action-buttons">
        {authorized || stage === "gone" ? null : (
          <span className="sign-in-card__expiry">
            {passwordSignInExpiry(payload.expiresAt, now)}
          </span>
        )}
        <div className="sign-in-card__answers">
          <button className="btn" disabled={locked} onClick={decline} type="button">
            {busy === "decline" ? "Declining…" : "Don’t allow"}
          </button>
          {offer ? (
            <>
              <button
                className="btn"
                disabled={locked || chosen === null}
                onClick={() => approve(false)}
                type="button"
              >
                Only this time
              </button>
              <button
                className="btn btn--primary"
                disabled={locked || chosen === null}
                onClick={() => approve(true)}
                ref={forwardRef}
                type="button"
              >
                <Icon name="key" />
                Allow
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * What else to say about the only account: the person's label, and its host
 * when that is not the page the agent is on, where the password may not work.
 */
function loneAccountDetail(account: PasswordSignInAccount, site: string): string | null {
  const offHost = !account.onPage && account.host !== browserSiteLabel(site) ? account.host : null;
  return [account.label, offHost].filter(Boolean).join(" · ") || null;
}

/**
 * Several accounts, of which the person chooses one. The page's accounts come
 * first; the site's other hosts wait behind one disclosure, each named once.
 * More than `filterAbove` accounts in view get a filter. The rows are one native radio
 * group, so the arrow keys move the choice and Return (the card's) allows it.
 */
function AccountChoice({
  accounts,
  chosenId,
  entryRef,
  onChoose,
  site,
}: {
  readonly accounts: readonly PasswordSignInAccount[];
  readonly chosenId: string | null;
  readonly entryRef: RefObject<HTMLInputElement | null>;
  readonly onChoose: (id: string) => void;
  readonly site: string;
}) {
  const id = useId();
  const listRef = useRef<HTMLFieldSetElement | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const filtering = query.trim() !== "";
  const { others, primary } = passwordSignInAccountList(accounts, query);
  // A filter only where it helps: a long list in view, or one already in use.
  const inView = passwordSignInAccountList(accounts);
  const filterable =
    query !== "" || count(inView.primary) + (expanded ? count(inView.others) : 0) > filterAbove;
  const visible = [...primary, ...others].flatMap(({ rows }) => rows);
  const otherCount = count(others);

  const radio = (accountId: string) =>
    listRef.current?.querySelector<HTMLInputElement>(`input[value="${accountId}"]`) ?? null;

  function onFilterKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    } else if (event.key === "Enter") {
      // Return here never answers the card; it chooses the one account left.
      event.preventDefault();
      event.stopPropagation();
      const only = visible.length === 1 ? visible[0]!.account.id : null;
      if (only === null) return;
      onChoose(only);
      radio(only)?.focus();
    } else if (event.key === "ArrowDown" && visible[0]) {
      event.preventDefault();
      radio(visible[0].account.id)?.focus();
    }
  }

  const option = (row: PasswordSignInAccountRow, hostId: string | null) => (
    <AccountOption
      checked={row.account.id === chosenId}
      entryRef={!filterable && row === visible[0] ? entryRef : null}
      hostId={hostId}
      key={row.account.id}
      name={id}
      onChoose={onChoose}
      row={row}
    />
  );
  const groups = (list: readonly PasswordSignInAccountGroup[], part: string): ReactNode =>
    list.map((group, index) => {
      const hostId = group.host === null ? null : `${id}-${part}-${index}`;
      return (
        <div className="account-choice__group" key={group.host ?? part}>
          {group.host === null ? null : (
            <p className="account-choice__host" id={hostId ?? undefined}>
              {group.host}
            </p>
          )}
          {group.rows.map((row) => option(row, hostId))}
        </div>
      );
    });

  return (
    <div className="account-choice">
      <div className="account-choice__head">
        <span className="account-choice__legend" id={`${id}-legend`}>
          Sign in as
        </span>
        {filterable ? (
          <input
            aria-label={passwordSignInAccountFilterLabel}
            autoComplete="off"
            className="text-input account-choice__filter"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              listRef.current?.scrollTo({ top: 0 });
            }}
            onKeyDown={onFilterKeyDown}
            placeholder={passwordSignInAccountFilterLabel}
            ref={entryRef}
            spellCheck={false}
            type="search"
            value={query}
          />
        ) : null}
      </div>
      <fieldset aria-labelledby={`${id}-legend`} className="account-choice__list" ref={listRef}>
        {groups(primary, "page")}
        {others.length > 0 ? (
          <details
            className="account-choice__others"
            onToggle={(event) => {
              if (filtering) return;
              const { open } = event.currentTarget;
              setExpanded(open);
              // Opened, it brings the accounts it held into the list's view.
              const list = listRef.current;
              if (open && list) {
                const top =
                  event.currentTarget.getBoundingClientRect().top -
                  list.getBoundingClientRect().top;
                list.scrollTo({ top: list.scrollTop + top - 4 });
              }
            }}
            open={filtering || expanded}
          >
            <summary>
              <Icon name="chevron-right" />
              {passwordSignInOtherAccounts(site, otherCount)}
            </summary>
            {groups(others, "other")}
          </details>
        ) : null}
        {visible.length === 0 ? (
          <p className="account-choice__empty">{passwordSignInNoAccountMatch(query.trim())}</p>
        ) : null}
      </fieldset>
    </div>
  );
}

function count(groups: readonly PasswordSignInAccountGroup[]): number {
  return groups.reduce((total, { rows }) => total + rows.length, 0);
}

function AccountOption({
  checked,
  entryRef,
  hostId,
  name,
  onChoose,
  row,
}: {
  readonly checked: boolean;
  readonly entryRef: RefObject<HTMLInputElement | null> | null;
  readonly hostId: string | null;
  readonly name: string;
  readonly onChoose: (id: string) => void;
  readonly row: PasswordSignInAccountRow;
}) {
  const detailId = useId();
  const { account, detail } = row;
  const describedBy = [hostId, detail === null ? null : detailId].filter(Boolean).join(" ");
  return (
    <label className="account-choice__option">
      <input
        aria-describedby={describedBy || undefined}
        aria-label={account.username}
        checked={checked}
        name={name}
        onChange={() => onChoose(account.id)}
        ref={entryRef ?? undefined}
        type="radio"
        value={account.id}
      />
      <AccountName value={account.username} />
      {detail === null ? null : (
        <span className="account-choice__detail" id={detailId}>
          {detail}
        </span>
      )}
    </label>
  );
}

/**
 * A username too wide for its row loses its middle, never its start or the
 * end of its domain; the whole value stays in the text and the tooltip.
 */
function AccountName({ value }: { readonly value: string }) {
  const at = value.lastIndexOf("@");
  const tail =
    at > 0 && value.length - at <= 24
      ? value.length - at
      : Math.min(13, Math.floor(value.length / 2));
  const cut = value.length - tail;
  return (
    <span className="account-name" title={value}>
      <span className="account-name__start">{value.slice(0, cut)}</span>
      <span className="account-name__end">{value.slice(cut)}</span>
    </span>
  );
}

/**
 * The sign-in as Electron main reports it: read once, then followed. A state
 * the Mac pushes is newer than any read still in flight, and newer than any
 * state the card assumes after an answer.
 */
export function useHostSignIn(
  client: PasswordSignInRequestClient,
  requestId: Request["id"] | null,
) {
  const [state, setState] = useState<PasswordSignInCard | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!requestId) return;
    let live = true;
    client.rpc["browser.password-sign-in.get"]({ requestId })
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setState(result.data);
          setReadError(null);
        } else setReadError(result.error.message);
      })
      .catch((reason: unknown) => {
        if (live) setReadError(actionErrorMessage(reason));
      });
    return () => {
      live = false;
    };
  }, [client, requestId, attempt]);
  return { state, readError, apply: setState, retry: () => setAttempt((value) => value + 1) };
}
