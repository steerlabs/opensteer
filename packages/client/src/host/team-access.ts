import { sha256 } from "@noble/hashes/sha2.js";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import type {
  AccessChange,
  HostApiCommandInput,
  HostApiCommandOutput,
  Level,
  MemberChange,
  Page,
  SettingsInput,
  Subject,
  TeamCommand,
  teamReadSchemas,
} from "@opensteer/protocol";
import { UserIdSchema, WorkspaceIdSchema } from "@opensteer/core";
import { AgentConnectionIdSchema } from "@opensteer/protocol";
import type { z } from "zod";
import type { HostClient } from "./client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";

type TeamReads = typeof teamReadSchemas;
type ReadName = keyof TeamReads;
export type TeamReadInput<Name extends ReadName> = z.input<TeamReads[Name]["input"]>;
export type TeamReadOutput<Name extends ReadName> = z.output<TeamReads[Name]["output"]>;
type CommandType = TeamCommand["type"];
type CommandResult<Type extends CommandType> = Extract<HostApiCommandOutput, { type: Type }>;
type CommandBody<Type extends CommandType> = Omit<
  Extract<HostApiCommandInput, { type: Type }>,
  "type" | "idempotencyKey" | "expectedRevision"
>;
type TeamPort = Pick<HostClient, "rpc" | "dispatch">;
interface ReadOptions {
  readonly signal?: AbortSignal;
}

export type TeamSummaryView = Exclude<TeamReadOutput<"team.summary.get">, { notModified: true }>;
export type ProjectRuntimeChoices = TeamReadOutput<"team.project.runtimeChoices">;
export type ProjectSettingsRead = TeamReadOutput<"team.project.settings.get">;
export type GroupDetail = TeamReadOutput<"team.group.get">;
export type PeoplePage = TeamReadOutput<"team.people.list">;
export type GroupsPage = TeamReadOutput<"team.groups.list">;
export type MemberDetailView = TeamReadOutput<"team.member.get">;
export type DirectoryResults = TeamReadOutput<"team.directory.search">;
export type InvitePreviewView = TeamReadOutput<"team.invitation.preview">;

/**
 * The person's Host as a team server: typed reads and commands. It decides
 * nothing; every answer, refusal and `can` comes from the Host.
 */
export class TeamAccess {
  readonly #port: TeamPort;
  readonly #listeners = new Set<() => void>();
  #summary: TeamSummaryView | null = null;

  constructor(port: TeamPort) {
    this.#port = port;
  }

  /** Called after every command the Host commits, so open screens read again. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Revalidates the cached summary; a Host that answers not-modified costs no body. */
  async summary(options: ReadOptions = {}): Promise<TeamSummaryView> {
    const known = this.#summary;
    const result = unwrapRpcResult(
      await this.#port.rpc["team.summary.get"](
        known ? { knownRevision: known.revision } : {},
        options,
      ),
    );
    if ("notModified" in result) {
      if (known && known.revision === result.revision) return known;
      this.#summary = null;
      return this.summary(options);
    }
    this.#summary = result;
    return result;
  }

  async people(
    input: Page & { query?: string; state?: "active" | "suspended" | "removed" },
    options: ReadOptions = {},
  ) {
    return unwrapRpcResult(await this.#port.rpc["team.people.list"](input, options));
  }
  async member(input: TeamReadInput<"team.member.get">, options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.member.get"](input, options));
  }
  async directory(input: TeamReadInput<"team.directory.search">, options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.directory.search"](input, options));
  }
  async groups(input: TeamReadInput<"team.groups.list">, options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.groups.list"](input, options));
  }
  async group(input: TeamReadInput<"team.group.get">, options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.group.get"](input, options));
  }
  async projectAccess(input: TeamReadInput<"team.project.access.get">, options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.project.access.get"](input, options));
  }
  async explain(input: TeamReadInput<"team.access.explain">, options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.access.explain"](input, options));
  }
  async previewAccess(
    expectedRevision: number,
    changes: readonly AccessChange[],
    options: ReadOptions = {},
  ) {
    return unwrapRpcResult(
      await this.#port.rpc["team.access.preview"](
        { expectedRevision, changes: [...changes] },
        options,
      ),
    );
  }
  async previewMember(userId: string, change: MemberChange, options: ReadOptions = {}) {
    return unwrapRpcResult(
      await this.#port.rpc["team.member.preview"](
        { userId: UserIdSchema.parse(userId), change },
        options,
      ),
    );
  }
  async audit(input: TeamReadInput<"team.audit.list">, options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.audit.list"](input, options));
  }
  async projectSettings(workspaceId: string, options: ReadOptions = {}) {
    return unwrapRpcResult(
      await this.#port.rpc["team.project.settings.get"](
        { workspaceId: WorkspaceIdSchema.parse(workspaceId) },
        options,
      ),
    );
  }
  async runtimeChoices(workspaceId: string, options: ReadOptions = {}) {
    return unwrapRpcResult(
      await this.#port.rpc["team.project.runtimeChoices"](
        { workspaceId: WorkspaceIdSchema.parse(workspaceId) },
        options,
      ),
    );
  }
  async invitationPreview(selector: string, options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.invitation.preview"]({ selector }, options));
  }
  async invitationExchange(link: TeamInvitationLink, options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.invitation.exchange"](link, options));
  }
  async invitationAccept(options: ReadOptions = {}) {
    return unwrapRpcResult(await this.#port.rpc["team.invitation.accept"]({}, options));
  }

  createProject(revision: number, input: CommandBody<"team.project.create">) {
    return this.#command("team.project.create", revision, input);
  }
  applyAccess(revision: number, changes: readonly AccessChange[]) {
    return this.#command("team.access.apply", revision, { changes: [...changes] });
  }
  selfGrant(revision: number, workspaceId: string) {
    return this.#command("team.access.selfGrant", revision, {
      workspaceId: WorkspaceIdSchema.parse(workspaceId),
    });
  }
  changeMember(revision: number, userId: string, change: MemberChange) {
    return this.#command("team.member.change", revision, {
      userId: UserIdSchema.parse(userId),
      change,
    });
  }
  revokeConnection(revision: number, connectionId: string) {
    return this.#command("team.connection.revoke", revision, {
      connectionId: AgentConnectionIdSchema.parse(connectionId),
    });
  }
  setProjectSettings(
    revision: number,
    workspaceId: string,
    expectedSettingsRevision: number | null,
    settings: SettingsInput,
  ) {
    return this.#command("team.project.settings.set", revision, {
      workspaceId: WorkspaceIdSchema.parse(workspaceId),
      expectedSettingsRevision,
      settings,
    });
  }
  /**
   * Sends only the verifier's digest. The draft keeps its idempotency key, so
   * retrying the same draft after a lost response cannot mint a second invite.
   */
  async createInvitation(
    revision: number,
    draft: TeamInvitationDraft,
    input: {
      readonly email: string;
      readonly kind: "full" | "guest";
      readonly validFor: "1d" | "7d";
    },
  ) {
    const result = await this.#dispatch("team.invitation.create", {
      type: "team.invitation.create",
      idempotencyKey: draft.idempotencyKey,
      expectedRevision: revision,
      id: draft.id,
      selector: draft.selector,
      tokenHash: draft.tokenHash,
      intendedEmail: input.email,
      memberKind: input.kind,
      validFor: input.validFor,
    });
    return result;
  }
  revokeInvitation(revision: number, invitationId: string) {
    return this.#command("team.invitation.revoke", revision, { invitationId });
  }

  #command<Type extends CommandType>(type: Type, revision: number, body: CommandBody<Type>) {
    return this.#dispatch(type, {
      ...body,
      type,
      idempotencyKey: mutationIdempotencyKey(type),
      expectedRevision: revision,
    } as Extract<HostApiCommandInput, { type: Type }>);
  }

  async #dispatch<Type extends CommandType>(
    type: Type,
    command: Extract<HostApiCommandInput, { type: Type }>,
  ): Promise<CommandResult<Type>> {
    const result = await this.#port.dispatch(command);
    if (result.type !== type) throw new Error(`The Host answered ${type} with ${result.type}.`);
    for (const listener of this.#listeners) listener();
    return result as CommandResult<Type>;
  }
}

export interface TeamInvitationLink {
  readonly selector: string;
  readonly verifier: string;
}

/** Everything one invitation needs before it is sent; the verifier never leaves this device. */
export interface TeamInvitationDraft extends TeamInvitationLink {
  readonly id: string;
  readonly tokenHash: string;
  readonly idempotencyKey: string;
}

export function createTeamInvitationDraft(
  randomBytes: (size: number) => Uint8Array = (size) =>
    globalThis.crypto.getRandomValues(new Uint8Array(size)),
): TeamInvitationDraft {
  const selector = encodeBase64Url(randomBytes(24));
  const verifier = encodeBase64Url(randomBytes(32));
  return {
    id: globalThis.crypto.randomUUID(),
    selector,
    verifier,
    tokenHash: teamInvitationTokenHash(verifier),
    idempotencyKey: mutationIdempotencyKey("team.invitation.create"),
  };
}

/** The Host's stored digest of a verifier: hex SHA-256 of its UTF-8 text. */
export function teamInvitationTokenHash(verifier: string): string {
  return [...sha256(new TextEncoder().encode(verifier))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const joinPath = /^\/join\/([A-Za-z0-9_-]{24,96})$/u;
const verifierPattern = /^[A-Za-z0-9_-]{43}$/u;

/** The verifier rides in the fragment, which browsers never send to a server. */
export function teamInvitationUrl(origin: string, link: TeamInvitationLink): string {
  return `${new URL(`/join/${link.selector}`, origin).href}#${link.verifier}`;
}

export function teamInvitationSelector(pathname: string): string | null {
  return joinPath.exec(pathname)?.[1] ?? null;
}

export function parseTeamInvitationUrl(value: string): TeamInvitationLink | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const selector = teamInvitationSelector(url.pathname);
  const verifier = url.hash.slice(1);
  return selector && verifierPattern.test(verifier) ? { selector, verifier } : null;
}

export function teamInvitationVerifier(fragment: string): string | null {
  const value = fragment.replace(/^#/u, "");
  return verifierPattern.test(value) ? value : null;
}

/** A level change is a revoke of the old entry and a grant of the new one, in one batch. */
export function changeLevelChanges(
  entry: {
    readonly id: string;
    readonly subject: Subject;
    readonly target: { readonly workspaceId: string };
  },
  level: Level,
  newEntryId: string = globalThis.crypto.randomUUID(),
): AccessChange[] {
  return [
    { kind: "revoke", entryId: entry.id },
    {
      kind: "grant",
      id: newEntryId,
      subject: subjectRef(entry.subject),
      target: { kind: "project", workspaceId: WorkspaceIdSchema.parse(entry.target.workspaceId) },
      level,
    },
  ];
}

export function grantChanges(
  workspaceId: string,
  subjects: readonly Subject[],
  level: Level,
): AccessChange[] {
  return subjects.map((subject) => ({
    kind: "grant",
    id: globalThis.crypto.randomUUID(),
    subject: subjectRef(subject),
    target: { kind: "project", workspaceId: WorkspaceIdSchema.parse(workspaceId) },
    level,
  }));
}

export function subjectRef(subject: Subject): Subject {
  return subject.kind === "person"
    ? { kind: "person", userId: subject.userId }
    : { kind: "group", groupId: subject.groupId };
}

export function subjectKey(subject: Subject): string {
  return subject.kind === "person" ? `person:${subject.userId}` : `group:${subject.groupId}`;
}
