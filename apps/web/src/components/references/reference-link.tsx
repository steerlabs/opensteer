import {
  Children,
  isValidElement,
  useMemo,
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { classifyHref, teamPageUrl, type Reference, type TeamPageLink } from "@opensteer/core";
import type { FileLinkTarget } from "@opensteer/shared/fileHref";
import { useReference } from "@opensteer/client/react";
import {
  fileIcon,
  localTeamReference,
  referenceIcon,
  refTarget,
  teamPageIcon,
} from "@opensteer/client/references";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import { useTeams, useTeamSessionValue } from "../../team/team-attachments.js";
import { ExternalLink } from "../external-link.js";
import { Icon, type IconName } from "../icon.js";
import { useToast } from "../toast.js";
import { useNearViewport } from "../use-near-viewport.js";
import { useOptionalWorkspace } from "../workspace/workspace-context.js";
import { referenceGlyphs } from "./reference-glyphs.js";
import {
  attachedTeam,
  isPersonalScope,
  useReferenceScope,
  type PersonalReferenceScope,
  type ReferenceScope,
} from "./reference-scope.js";

/**
 * Every link in rendered Markdown, on every surface: what its destination is
 * decides what it becomes. A reference to something in Opensteer is a chip
 * that opens it here; a web page opens as it always has for those words (a
 * workspace tab for a transcript, the reader's browser for a team message);
 * anything else keeps its words.
 */
export function ReferenceLink(props: LinkProps) {
  return <Link {...props} web="workspace" />;
}

export function TeamMessageLink(props: LinkProps) {
  return <Link {...props} web="external" />;
}

type LinkProps = ComponentProps<"a"> & {
  /** Punctuation that followed the link in the source (`remarkChipPunctuation`). */
  readonly "data-trailing"?: string;
};

function Link({
  children,
  href,
  web,
  "data-trailing": trailing,
}: LinkProps & { readonly web: "workspace" | "external" }) {
  const scope = useReferenceScope();
  const target = useMemo(() => classifyHref(href ?? ""), [href]);
  // A chip keeps the punctuation after it on its line; words wrap as words do.
  const chip = (element: ReactNode) =>
    trailing ? (
      <span className="ref-chip-group">
        {element}
        {trailing}
      </span>
    ) : (
      element
    );
  const words = (element: ReactNode) => (
    <>
      {element}
      {trailing}
    </>
  );
  switch (target.kind) {
    case "reference":
      return isPersonalScope(scope)
        ? chip(<PersonalChip label={textOf(children)} reference={target.reference} scope={scope} />)
        : words(<span>{children}</span>);
    case "team-page":
      return target.page.target.kind === "invite"
        ? words(
            <WebLink href={teamPageUrl(target.page)} web={web}>
              {children}
            </WebLink>,
          )
        : chip(<TeamPageChip label={textOf(children)} page={target.page} scope={scope} />);
    case "file":
      return isPersonalScope(scope)
        ? chip(<FileChip file={target.file} scope={scope} />)
        : words(<span>{children}</span>);
    case "web":
    case "mail":
      return words(
        <WebLink href={target.url} web={web}>
          {children}
        </WebLink>,
      );
    case "none":
      return words(<span>{children}</span>);
  }
}

/** A link's written words, for a chip that shows them on one line. */
export function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode; alt?: string }>(child)
          ? (child.props.alt ?? textOf(child.props.children))
          : "",
    )
    .join("");
}

function ChipFace({
  glyph,
  position,
  title,
}: {
  readonly glyph: IconName;
  readonly position?: string;
  readonly title: string;
}) {
  return (
    <>
      <Icon name={glyph} />
      <span className="ref-chip__title">{title}</span>
      {position ? <span className="ref-chip__position">{position}</span> : null}
    </>
  );
}

/** Opens on a press or Enter, never through the browser: its target is in this app. */
function activation(open: () => void) {
  return {
    onClick: (event: MouseEvent) => {
      event.preventDefault();
      open();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      open();
    },
    role: "link",
    tabIndex: 0,
  } as const;
}

const kindLabels: Readonly<Record<Reference["kind"], string>> = {
  task: "Task",
  run: "Run",
  request: "Request",
  message: "Message",
  automation: "Automation",
  computer: "Computer",
  attachment: "Attachment",
};

function PersonalChip({
  label,
  reference,
  scope,
}: {
  readonly label: string;
  readonly reference: Reference;
  readonly scope: PersonalReferenceScope;
}) {
  const element = useRef<HTMLElement | null>(null);
  // Only a chip near the screen, and not folded away, asks the Host what it names.
  const near = useNearViewport(element);
  const { client } = scope.context;
  const state = useReference(client, reference, { enabled: near });
  const toast = useToast();
  const written = label.trim() || kindLabels[reference.kind];
  const glyph = referenceGlyphs[referenceIcon(reference.kind)];
  if (state.state === "unavailable")
    return (
      <span
        aria-disabled="true"
        className="ref-chip ref-chip--unavailable"
        ref={(node) => {
          element.current = node;
        }}
        title="No longer available"
      >
        <ChipFace glyph={glyph} title={written} />
      </span>
    );
  const title = state.state === "available" ? state.value.title : written;
  const open = async () => {
    try {
      const value =
        state.state === "available"
          ? state.value
          : await client.references.resolve(reference.id, { refresh: state.state === "failed" });
      if (value.status === "unavailable") return;
      await scope.navigation.openReference(refTarget(value));
    } catch {
      toast.error("Couldn't open this. Try again.");
    }
  };
  return (
    <a
      {...activation(() => void open())}
      aria-label={`${kindLabels[reference.kind]}, ${title}`}
      className="ref-chip"
      data-reference-state={state.state}
      ref={(node) => {
        element.current = node;
      }}
      title={title}
    >
      <ChipFace glyph={glyph} title={title} />
    </a>
  );
}

function TeamPageChip({
  label,
  page,
  scope,
}: {
  readonly label: string;
  readonly page: TeamPageLink;
  readonly scope: ReferenceScope | null;
}) {
  const { teams } = useTeams();
  const team = attachedTeam(teams, page);
  // A team page names itself by what the session already holds; it is never looked up.
  const held = useTeamSessionValue(team?.client ?? null, (snapshot) =>
    snapshot
      ? (localTeamReference(page, {
          origin: page.origin,
          ...(snapshot.sidebar ? { sidebar: snapshot.sidebar } : {}),
          ...(snapshot.channel ? { channel: snapshot.channel } : {}),
          ...(snapshot.thread ? { thread: snapshot.thread } : {}),
        })?.title ?? null)
      : null,
  );
  const title = held ?? (label.trim() || "Team page");
  const url = teamPageUrl(page);
  const glyph = referenceGlyphs[teamPageIcon(page.target.kind)];
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    const desktop = desktopBridge() !== null;
    const gesture = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    // In a browser without that team's session, the anchor opens the team's own address.
    if (!scope || (!desktop && (gesture || !team))) return;
    event.preventDefault();
    void scope.navigation.openTeamPage(page);
  };
  return (
    <a
      className="ref-chip"
      href={url}
      onClick={open}
      rel="noopener noreferrer"
      target="_blank"
      title={title}
    >
      <ChipFace glyph={glyph} title={title} />
    </a>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function filePosition(file: FileLinkTarget): string {
  if (file.line === undefined) return "";
  if (file.column !== undefined) return `:${file.line}:${file.column}`;
  if (file.endLine !== undefined) return `:${file.line}-${file.endLine}`;
  return `:${file.line}`;
}

function FileChip({
  file,
  scope,
}: {
  readonly file: FileLinkTarget;
  readonly scope: PersonalReferenceScope;
}) {
  const name = basename(file.path);
  const position = filePosition(file);
  return (
    <a
      {...activation(
        () =>
          void scope.navigation.openFile({
            source: { kind: "path", path: file.path },
            ...(file.line === undefined ? {} : { line: file.line }),
            ...(file.column === undefined ? {} : { column: file.column }),
            ...(file.endLine === undefined ? {} : { endLine: file.endLine }),
          }),
      )}
      aria-label={`File, ${name}${position}`}
      className="ref-chip ref-chip--file"
      title={file.path + position}
    >
      <ChipFace glyph={referenceGlyphs[fileIcon(file.path)]} position={position} title={name} />
    </a>
  );
}

/**
 * A web page an agent named opens as a workspace tab, as if its address were
 * typed on the start page: the agent's computer can reach its own localhost
 * and network, and its profiles hold its sign-ins, where the reader's device
 * may not. A browser keeps its own gestures for a link; the desktop window has
 * none, so there a middle click opens it too. A team message's web pages open
 * in the reader's own browser, as they always have.
 */
function WebLink({
  children,
  href,
  web,
}: {
  readonly children: ReactNode;
  readonly href: string;
  readonly web: "workspace" | "external";
}) {
  const workspace = useOptionalWorkspace();
  const mail = href.startsWith("mailto:");
  if (web === "external")
    return mail ? <span>{children}</span> : <ExternalLink href={href}>{children}</ExternalLink>;
  if (mail)
    return desktopBridge() ? (
      <span>{children}</span>
    ) : (
      <ExternalLink href={href}>{children}</ExternalLink>
    );
  if (!workspace) return <span>{children}</span>;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    const gesture =
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
    // A right click raises auxclick too; it never opens a link.
    if (desktopBridge() ? event.button > 1 : gesture) return;
    event.preventDefault();
    workspace.openWebLink(href);
  };
  return (
    <a href={href} onAuxClick={open} onClick={open} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}
