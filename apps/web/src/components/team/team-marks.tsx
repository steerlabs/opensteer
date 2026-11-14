import { memo, type CSSProperties } from "react";
import { Icon } from "../icon.js";
import {
  type AuthorView,
  type ChannelKind,
  type MentionView,
  type PersonView,
  type TeamTileView,
} from "./team-models.js";

export type AvatarSize = 16 | 18 | 20 | 24 | 28 | 36;

/** A person's face: their photo, or their initial on their colour. */
export const PersonAvatar = memo(function PersonAvatar({
  person,
  presence = false,
  size,
}: {
  readonly person: PersonView;
  /** Show the green dot when they are active. */
  readonly presence?: boolean;
  readonly size: AvatarSize;
}) {
  return (
    <span
      aria-hidden
      className={`person-face person-face--${size}`}
      style={{ "--person-face-tint": person.tint } as CSSProperties}
    >
      {person.avatarUrl ? (
        <img alt="" decoding="async" draggable={false} src={person.avatarUrl} />
      ) : (
        <span className="person-face__initial">{initial(person.name)}</span>
      )}
      {presence && person.presence === "active" ? <span className="person-face__presence" /> : null}
    </span>
  );
});

/**
 * An author's face. An agent wears its owner's face with Opensteer's orb in
 * the corner, so it reads as that person's and never as a bot of its own.
 */
export function AuthorAvatar({
  author,
  size,
}: {
  readonly author: AuthorView;
  readonly size: AvatarSize;
}) {
  if (author.kind === "person") return <PersonAvatar person={author.person} size={size} />;
  return (
    <span aria-hidden className="person-face-badged">
      <PersonAvatar person={author.owner} size={size} />
      <AgentBadge />
    </span>
  );
}

/** Opensteer's orb, small: the mark that says "an agent", on a face or a chip. */
export function AgentBadge({ className }: { readonly className?: string }) {
  return (
    <span aria-hidden className={className ? `agent-badge ${className}` : "agent-badge"}>
      <img alt="" decoding="async" draggable={false} src="/opensteer.png" />
    </span>
  );
}

/** A few faces, overlapping, newest first. */
export function FaceStack({
  authors,
  size = 18,
}: {
  readonly authors: readonly AuthorView[];
  readonly size?: 16 | 18 | 20;
}) {
  return (
    <span aria-hidden className={`face-stack face-stack--${size}`}>
      {authors.slice(0, 3).map((author, index) => (
        <AuthorAvatar
          author={author}
          key={`${author.kind}:${author.kind === "agent" ? author.owner.id : author.person.id}:${index}`}
          size={size}
        />
      ))}
    </span>
  );
}

/** A team's tile: its initial on its colour, lit like every mark. */
export function TeamTile({
  size = 18,
  tile,
}: {
  readonly size?: 14 | 18 | 20 | 28 | 56;
  readonly tile: TeamTileView;
}) {
  return (
    <span
      aria-hidden
      className={`team-tile team-tile--${size}`}
      style={{ "--team-tile-tint": tile.color } as CSSProperties}
    >
      {initial(tile.name)}
    </span>
  );
}

/** "#" for a public channel, a lock for a private one, faces for a DM. */
export function ChannelGlyph({
  kind,
  people = [],
}: {
  readonly kind: ChannelKind;
  readonly people?: readonly PersonView[] | undefined;
}) {
  if (kind === "public") return <Icon className="channel-glyph" name="hash" />;
  if (kind === "private") return <Icon className="channel-glyph" name="lock" />;
  const [first, second] = people;
  if (!first) return <Icon className="channel-glyph" name="user" />;
  if (kind === "dm" || !second) return <PersonAvatar person={first} presence size={20} />;
  return (
    <span aria-hidden className="dm-pair">
      <PersonAvatar person={first} size={16} />
      <PersonAvatar person={second} size={16} />
    </span>
  );
}

/** One sentence everywhere: an agent can do whatever its owner can, unless the thing is people only. */
export const peopleOnlyRule =
  "Your agent can do whatever you can, unless the thing is marked people only.";

export function PeopleOnlyBadge({ compact = false }: { readonly compact?: boolean }) {
  return (
    <span className="people-only" title={peopleOnlyRule}>
      <Icon name="user" />
      {compact ? <span className="visually-hidden">People only</span> : "People only"}
    </span>
  );
}

/**
 * A mention in the words this viewer reads. A live ask of an agent is ember
 * with the orb; an ask waiting for another owner's approval is outlined;
 * a mention of the reader is amber.
 */
export function MentionChip({ mention }: { readonly mention: MentionView }) {
  return (
    <span className={`mention mention--${mention.tone}`} data-handle={mention.handle}>
      {mention.tone === "agent" ? <span aria-hidden className="mention__dot" /> : null}@
      {mention.label}
      {mention.externalTeam ? (
        <span className="team-external">External · {mention.externalTeam}</span>
      ) : null}
    </span>
  );
}

function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}
