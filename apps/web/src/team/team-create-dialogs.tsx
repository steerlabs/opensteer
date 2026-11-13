import { useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { createId, TeamChannelIdSchema, type UserId } from "@opensteer/core";
import { teamDmMaxParticipants } from "@opensteer/protocol";
import {
  channelNameFromInput,
  channelNamed,
  isChannelNameTaken,
  newChannelCommand,
  pickablePeople,
} from "@opensteer/client/team";
import { unwrapRpcResult } from "@opensteer/client/host";
import { useMountedRef } from "@opensteer/client/react";
import { Dialog } from "../components/dialog.js";
import { Icon } from "../components/icon.js";
import { LoadingRows } from "../components/loading-rows.js";
import { OptionRow } from "../components/option-row.js";
import { PersonAvatar } from "../components/team/team-marks.js";
import { firstName } from "../components/team/team-models.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { channelPath } from "./team-paths.js";
import { useTeamView, type TeamView } from "./team-view.js";
import { person } from "./team-view-models.js";

const noPreviews: ReadonlyMap<string, string> = new Map();

/**
 * A new channel: a name, who can find it, and whether agents are kept out. A private one
 * can start with people in it. Opens the channel it made.
 */
export function NewChannelDialog({
  initialName = "",
  onClose,
  onInvite,
  teamId,
}: {
  readonly initialName?: string;
  readonly onClose: () => void;
  readonly onInvite: (() => void) | undefined;
  readonly teamId: string;
}) {
  const view = useTeamView(teamId, noPreviews);
  const navigate = useNavigate();
  const toast = useToast();
  const shown = useMountedRef();
  const formId = useId();
  const [id] = useState(() => TeamChannelIdSchema.parse(createId("teamChannel")));
  const [name, setName] = useState(initialName);
  const [isPrivate, setPrivate] = useState(false);
  const [peopleOnly, setPeopleOnly] = useState(false);
  const [people, setPeople] = useState<readonly UserId[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ name: string; message: string } | null>(null);
  if (!view) return null;
  const teamName = view.snapshot.bootstrap?.teamName ?? view.team.name;
  const offline = view.snapshot.connection !== "connected";
  const words = channelNameFromInput(name);
  const joined = channelNamed(
    view.snapshot.sidebar?.channels.map((row) => row.channel) ?? [],
    name,
  );
  const refused = refusal !== null && refusal.name === words ? refusal.message : null;
  const ready = words !== "" && joined === null && refused === null && !offline && !busy;
  const create = (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready) return;
    setBusy(true);
    void view.client.rpc["commands.dispatch"](
      newChannelCommand({ id, name, isPrivate, peopleOnly, people }),
    )
      .then(unwrapRpcResult)
      .then(() => {
        // Closed while it was being made: the channel is in the sidebar, and nothing moves.
        if (!shown.current) return;
        onClose();
        void navigate(channelPath(teamId, id));
      })
      .catch((error: unknown) => {
        if (!shown.current) return;
        setBusy(false);
        if (isChannelNameTaken(error))
          setRefusal({ name: words, message: actionErrorMessage(error) });
        else toast.error(actionErrorMessage(error));
      });
  };
  const nameError = joined ? (
    <>
      You’re already in #{joined.name}.{" "}
      <button
        className="link-button"
        onClick={() => {
          onClose();
          void navigate(channelPath(teamId, joined.id));
        }}
        type="button"
      >
        Open it
      </button>
    </>
  ) : (
    refused
  );
  return (
    <Dialog
      footer={
        <>
          <span className="team-create__note">
            {offline
              ? `Can’t reach ${teamName} right now.`
              : !isPrivate
                ? `Anyone in ${teamName} can find and join it.`
                : people.length === 0
                  ? "Just you for now. You can add people later."
                  : `You and ${people.length === 1 ? firstName(person(view.words, people[0]!)) : `${people.length} people`}. You’ll manage it.`}
          </span>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!ready} form={formId} type="submit">
            {busy ? "Creating…" : "Create channel"}
          </button>
        </>
      }
      labelledBy={`${formId}-title`}
      onClose={onClose}
      title="New channel"
    >
      <form className="team-create" id={formId} onSubmit={create}>
        <div className="field">
          <label className="field__label" htmlFor={`${formId}-name`}>
            Name
          </label>
          <div className={nameError ? "team-create__name is-invalid" : "team-create__name"}>
            <Icon name={isPrivate ? "lock" : "hash"} />
            <input
              aria-describedby={nameError ? `${formId}-name-error` : undefined}
              aria-invalid={nameError ? true : undefined}
              autoComplete="off"
              autoFocus
              id={`${formId}-name`}
              maxLength={160}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="e.g. launch-plans"
              spellCheck={false}
              value={name}
            />
          </div>
          {nameError ? (
            <p className="team-create__error" id={`${formId}-name-error`} role="alert">
              {nameError}
            </p>
          ) : null}
        </div>
        <fieldset className="option-row-group team-create__options">
          <legend className="visually-hidden">Who it’s for</legend>
          <OptionRow
            as="switch"
            checked={isPrivate}
            detail="Only people you add can find and read it."
            leading={
              <span aria-hidden className="option-row__glyph">
                <Icon name="lock" />
              </span>
            }
            onChange={setPrivate}
            title="Private"
          />
          <OptionRow
            as="switch"
            checked={peopleOnly}
            detail="Agents can’t read or post here, including yours."
            leading={
              <span aria-hidden className="option-row__glyph team-create__people-glyph">
                <Icon name="user" />
              </span>
            }
            onChange={setPeopleOnly}
            title="People only"
          />
        </fieldset>
        {isPrivate ? (
          <div className="field">
            <span className="field__label team-create__label" id={`${formId}-people`}>
              Add people <span className="team-create__optional">Optional</span>
            </span>
            <PeoplePicker
              chosen={people}
              compact
              labelledBy={`${formId}-people`}
              onChange={setPeople}
              onInvite={onInvite}
              view={view}
            />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * A message to one person, or a group of a few. Opens the conversation those people already
 * have, or starts it.
 */
export function NewMessageDialog({
  onClose,
  onInvite,
  teamId,
}: {
  readonly onClose: () => void;
  readonly onInvite: (() => void) | undefined;
  readonly teamId: string;
}) {
  const view = useTeamView(teamId, noPreviews);
  const navigate = useNavigate();
  const toast = useToast();
  const shown = useMountedRef();
  const labelId = useId();
  const [chosen, setChosen] = useState<readonly UserId[]>([]);
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const teamName = view.snapshot.bootstrap?.teamName ?? view.team.name;
  const offline = view.snapshot.connection !== "connected";
  const open = () => {
    if (chosen.length === 0 || offline || busy) return;
    setBusy(true);
    void view.client.rpc["commands.dispatch"]({ type: "team.dm.open", participants: [...chosen] })
      .then(unwrapRpcResult)
      .then((result) => {
        if (result.type !== "team.dm.open" || !shown.current) return;
        onClose();
        void navigate(channelPath(teamId, result.channel.id));
      })
      .catch((error: unknown) => {
        if (!shown.current) return;
        setBusy(false);
        toast.error(actionErrorMessage(error));
      });
  };
  const first = chosen[0] ? firstName(person(view.words, chosen[0])) : null;
  return (
    <Dialog
      footer={
        <>
          <span className="team-create__note">
            {offline
              ? `Can’t reach ${teamName} right now.`
              : chosen.length > 1
                ? `A group message. Up to ${teamDmMaxParticipants} people.`
                : chosen.length === 0
                  ? "Pick one person, or a few for a group."
                  : null}
          </span>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={chosen.length === 0 || offline || busy}
            onClick={open}
            type="button"
          >
            {busy
              ? "Opening…"
              : chosen.length > 1
                ? `Message ${chosen.length} people`
                : first
                  ? `Message ${first}`
                  : "Message"}
          </button>
        </>
      }
      labelledBy={`${labelId}-title`}
      onClose={onClose}
      title="New message"
    >
      <PeoplePicker
        autoFocus
        chosen={chosen}
        label="To"
        max={teamDmMaxParticipants}
        onChange={setChosen}
        onInvite={onInvite}
        onSubmit={open}
        view={view}
      />
    </Dialog>
  );
}

/**
 * Choosing people: who is chosen stays in the field as chips, and the list below toggles
 * them. Enter takes the first match, or submits once the search is empty; Backspace in an
 * empty search takes back the last one chosen.
 */
function PeoplePicker({
  autoFocus = false,
  chosen,
  compact = false,
  label,
  labelledBy,
  max,
  onChange,
  onInvite,
  onSubmit,
  view,
}: {
  readonly autoFocus?: boolean;
  readonly chosen: readonly UserId[];
  /** A short list inside a longer form, rather than the dialog's whole body. */
  readonly compact?: boolean;
  /** A word inside the field, before the chips: "To". */
  readonly label?: string;
  readonly labelledBy?: string;
  /** The most that can be chosen, when there is a limit. */
  readonly max?: number;
  readonly onChange: (chosen: readonly UserId[]) => void;
  readonly onInvite: (() => void) | undefined;
  readonly onSubmit?: () => void;
  readonly view: TeamView;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const teamName = view.snapshot.bootstrap?.teamName ?? view.team.name;
  const others = pickablePeople(view.members.values(), view.words.viewerUserId, "");
  const shown = query.trim() === "" ? others : pickablePeople(others, "", query);
  const full = max !== undefined && chosen.length >= max;
  const toggle = (userId: UserId) => {
    onChange(
      chosen.includes(userId)
        ? chosen.filter((id) => id !== userId)
        : full
          ? chosen
          : [...chosen, userId],
    );
    setQuery("");
    input.current?.focus();
  };
  if (others.length === 0)
    return view.people === "reading" ? (
      <LoadingRows label="Loading people" />
    ) : (
      <div className="people-picker__empty">
        <span aria-hidden className="people-picker__empty-mark">
          <Icon name="users" />
        </span>
        <p className="people-picker__empty-title">
          {view.people === "failed" ? "Can’t load people right now" : "No one else is here yet"}
        </p>
        <p className="people-picker__empty-detail">
          {view.people === "failed"
            ? `Check your connection to ${teamName} and try again.`
            : `Invite people to ${teamName}, then you can pick them here.`}
        </p>
        {view.people !== "failed" && onInvite ? (
          <button className="btn btn--small" onClick={onInvite} type="button">
            <Icon name="plus" />
            Invite people
          </button>
        ) : null}
      </div>
    );
  return (
    <div className={compact ? "people-picker people-picker--compact" : "people-picker"}>
      <div className="people-picker__field" onClick={() => input.current?.focus()}>
        {label ? <span className="people-picker__label">{label}</span> : null}
        {chosen.map((userId) => {
          const face = person(view.words, userId);
          return (
            <span className="people-chip" key={userId}>
              <PersonAvatar person={face} size={18} />
              <span className="people-chip__name">{face.name}</span>
              <button
                aria-label={`Remove ${face.name}`}
                className="people-chip__remove"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(userId);
                }}
                type="button"
              >
                <Icon name="close" />
              </button>
            </span>
          );
        })}
        <input
          aria-controls={listId}
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : (label ?? "Find people")}
          autoComplete="off"
          autoFocus={autoFocus}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const top = shown[0];
              if (query.trim() !== "" && top) toggle(top.userId);
              else if (query.trim() === "") onSubmit?.();
            } else if (event.key === "Backspace" && query === "" && chosen.length > 0) {
              onChange(chosen.slice(0, -1));
            }
          }}
          placeholder={chosen.length === 0 ? "Name or @handle" : ""}
          ref={input}
          spellCheck={false}
          value={query}
        />
      </div>
      {shown.length === 0 ? (
        <p className="people-picker__none">
          No one called “{query.trim()}” in {teamName}.
        </p>
      ) : (
        <ul aria-label="People" className="people-picker__list" id={listId}>
          {shown.map((member, index) => {
            const face = person(view.words, member.userId);
            const picked = chosen.includes(member.userId);
            return (
              <li key={member.userId}>
                <button
                  aria-pressed={picked}
                  className={
                    index === 0 && query.trim() !== "" ? "people-row is-active" : "people-row"
                  }
                  disabled={!picked && full}
                  onClick={() => toggle(member.userId)}
                  type="button"
                >
                  <PersonAvatar person={face} presence size={28} />
                  <span className="people-row__text">
                    <span className="people-row__name">{face.name}</span>
                    <span className="people-row__handle">@{face.handle}</span>
                  </span>
                  <span
                    aria-hidden
                    className={picked ? "people-row__check is-on" : "people-row__check"}
                  >
                    <Icon name="check" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {full ? (
        <p className="people-picker__none">A message holds up to {max} people besides you.</p>
      ) : null}
    </div>
  );
}
