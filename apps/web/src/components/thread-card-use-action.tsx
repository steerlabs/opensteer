import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Request } from "@opensteer/core";
import {
  cardUseConsent,
  cardUseEmpty,
  cardUseOutcome,
  cardUseTitle,
  cardChoiceLabel,
  mutationIdempotencyKey,
  passwordSignInExpiry,
} from "@opensteer/client/host";
import {
  useHostSignIn,
  type PasswordSignInRequestClient,
} from "./thread-password-sign-in-action.js";
import { actionErrorMessage } from "../ui-utils.js";

export function CardUseRequestBody({
  client,
  disabled,
  request,
}: {
  readonly client: PasswordSignInRequestClient;
  readonly disabled: boolean;
  readonly request: Request;
}) {
  const pending = request.status === "pending";
  const chooser = useHostSignIn(client, pending && !disabled ? request.id : null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const declineKey = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const name = useId();
  const stage = chooser.state?.stage;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(new Date()), 5000);
    return () => window.clearInterval(timer);
  }, [pending]);
  useEffect(() => {
    if (stage !== "card-approval") return;
    const active = document.activeElement;
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      !root.current?.contains(active)
    )
      return;
    root.current?.querySelector<HTMLElement>("input, button[data-forward]")?.focus();
  }, [stage]);
  if (request.payload.kind !== "browser.password-sign-in") return null;
  const payload = request.payload;
  const outcome = cardUseOutcome(request);
  if (outcome) return <p role="status">{outcome.text}</p>;
  const cards = chooser.state?.stage === "card-approval" ? chooser.state.cards : [];
  const chosen = cards.length === 1 ? cards[0] : cards.find(({ id }) => id === chosenId);
  const expired = Date.parse(payload.expiresAt) <= now.getTime();
  const locked = disabled || busy || stage === "authorized";
  async function respond(allow: boolean) {
    if (locked || (allow && (!chosen || expired || stage !== "card-approval"))) return;
    setBusy(true);
    setError(null);
    declineKey.current ??= mutationIdempotencyKey(`card-use:${request.id}`);
    try {
      const result = await client.dispatch({
        type: "browser.password-sign-in.respond",
        requestId: request.id,
        idempotencyKey: allow
          ? mutationIdempotencyKey(`card-use:${request.id}`)
          : declineKey.current,
        decision:
          allow && chosen
            ? {
                kind: "approve-card",
                cardId: chosen.id,
                revision: chosen.revision,
                permissionVersion: 7,
              }
            : { kind: "decline" },
      });
      if (result.type === "browser.password-sign-in.respond") {
        if (result.card) chooser.apply(result.card);
        if (result.message) setError(result.message);
        if (result.status === "pending" && allow) setBusy(false);
      }
    } catch (reason) {
      setError(actionErrorMessage(reason));
      chooser.retry();
      setBusy(false);
    }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      void respond(false);
    }
    if (event.key === "Enter" && !event.shiftKey && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      void respond(true);
    }
  }
  return (
    <div className="sign-in-card" ref={root} onKeyDown={keyDown}>
      <p className="sign-in-card__lead">{cardUseTitle(payload.site)}</p>
      <div className="action-field">
        <span className="eyebrow eyebrow--micro">Agent’s reason</span>
        <span>{payload.reason}</span>
      </div>
      {stage === "card-approval" ? (
        cards.length === 0 ? (
          <p>{cardUseEmpty(payload.computerName ?? "your Mac")}</p>
        ) : (
          <fieldset className="account-choice__list">
            <legend>Choose a card</legend>
            {cards.map((card) => (
              <label className="account-choice__option" key={card.id}>
                <input
                  type="radio"
                  name={name}
                  checked={chosen?.id === card.id}
                  disabled={locked || expired}
                  onChange={() => setChosenId(card.id)}
                />
                {cardChoiceLabel(card)}
              </label>
            ))}
          </fieldset>
        )
      ) : (
        <p role="status">
          {stage === "gone"
            ? "This card use is no longer running."
            : stage === "authorized"
              ? "Allowed card use"
              : "Loading cards…"}
        </p>
      )}
      <p>{cardUseConsent(payload.site, payload.expiresAt)}</p>
      <span className="sign-in-card__expiry">{passwordSignInExpiry(payload.expiresAt, now)}</span>
      {chooser.readError ? (
        <p role="alert">
          {chooser.readError}{" "}
          <button className="btn" onClick={chooser.retry}>
            Try again
          </button>
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="action-buttons">
        <button className="btn" disabled={locked} onClick={() => void respond(false)}>
          Don’t allow
        </button>
        {chosen ? (
          <button
            data-forward
            className="btn btn--primary"
            disabled={locked || expired}
            onClick={() => void respond(true)}
          >
            Allow card use
          </button>
        ) : null}
      </div>
    </div>
  );
}
