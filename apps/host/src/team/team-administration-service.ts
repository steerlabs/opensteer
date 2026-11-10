import { consumeAnonymousRateLimit } from "../identity/anonymous-rate-limit.js";
import { contextClientAddress } from "../identity/anonymous-client-address.js";
import { createHash } from "node:crypto";
import {
  CommandIdSchema,
  HarnessIdSchema,
  WorkspaceIdSchema,
  WorkspaceBindingIdSchema,
  OpensteerError,
  createId,
  storedModelSelection,
  type AccessMutation,
  type AuthenticatedHuman,
  type AuthenticatedSession,
  type RunnerId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  TeamAccessReadStore,
  acceptTeamInvitation,
  checkAccess,
  getProjectRuntimeSettings,
  mutateAccess,
  mutateTeamInvitation,
  previewAccess,
  previewMemberAccess,
  readDeploymentAuthority,
  readTeamInvitation,
  resolveProjectRuntime,
  revokeTeamConnection,
  setProjectRuntimeSettings,
  type DatabaseSchema,
} from "@opensteer/database";
import {
  HarnessInstanceCatalogSchema,
  TeamCommandSchema,
  TeamCommandResultSchema,
  teamReadSchemas,
  type Can,
  type MemberChange,
  type MemberSummary,
  type TeamCommand,
  type TeamReason,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { IdentityService } from "@opensteer/identity";
import type { Kysely } from "kysely";

type Procedure = keyof typeof teamReadSchemas;
type Identity = Pick<
  IdentityService,
  "configuration" | "exchangeTeamInvitation" | "teamInvitationAdmission"
>;

function allowed(value: boolean, reason: TeamReason): Can {
  return value ? { allowed: true } : { allowed: false, reason };
}
function refuse(reason: TeamReason, code: "forbidden" | "not_found" = "forbidden"): never {
  throw new OpensteerError({ code, reason, message: `Team administration refused: ${reason}.` });
}

function uuidFor(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function memberChange(userId: UserId, change: MemberChange): AccessMutation {
  switch (change.kind) {
    case "set-kind":
      return { kind: "member", userId, memberKind: change.value };
    case "set-state":
      return { kind: "member", userId, memberState: change.value };
    case "set-administrator":
      return { kind: "member", userId, administrator: change.value };
  }
}

function headersFrom(context: HostApiServerContext): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(context.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else for (const item of value ?? []) headers.append(name, item);
  }
  return headers;
}

export class TeamAdministrationService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #reads: TeamAccessReadStore;
  readonly #identity: Identity;
  readonly #teamName: string;
  readonly #runnerIsConnected: (runnerId: RunnerId) => boolean;
  readonly #invalidate: (userIds: readonly UserId[]) => void;
  readonly #publicBudget = new Map<string, { at: number; remaining: number }>();

  constructor(options: {
    database: Kysely<DatabaseSchema>;
    identity: Identity;
    teamName: string;
    runnerIsConnected: (runnerId: RunnerId) => boolean;
    invalidate: (userIds: readonly UserId[]) => void;
  }) {
    this.#database = options.database;
    this.#reads = new TeamAccessReadStore(options.database);
    this.#identity = options.identity;
    this.#teamName = options.teamName.slice(0, 120);
    this.#runnerIsConnected = options.runnerIsConnected;
    this.#invalidate = options.invalidate;
  }

  async #authority(): Promise<void> {
    const authority = await readDeploymentAuthority(this.#database);
    if (authority.kind !== "server" || authority.model !== 2) refuse("team-unavailable");
  }

  #session(context: HostApiServerContext): AuthenticatedSession {
    if (!context.session) refuse("human-session-required");
    return context.session;
  }

  async #human(context: HostApiServerContext) {
    const session = this.#session(context);
    await this.#authority();
    const actor = { userId: session.user.id, sessionId: session.id };
    const authority = await this.#reads.authority(actor);
    return {
      ...authority,
      actor: { ...actor, authorityGeneration: Number(authority.user.authorityGeneration) },
    };
  }

  #member(
    member: Omit<MemberSummary, "can">,
    activeAdmins: number,
    administrator = true,
  ): MemberSummary {
    const last = member.administrator && member.state === "active" && activeAdmins === 1;
    if (!administrator)
      return {
        ...member,
        can: {
          setKind: allowed(false, "team-admin-required"),
          setState: allowed(false, "team-admin-required"),
          setAdministrator: allowed(false, "team-admin-required"),
          revokeConnections: allowed(false, "team-admin-required"),
        },
      };
    return {
      ...member,
      can: {
        setKind: allowed(member.state !== "removed", "member-removed"),
        setState: allowed(
          !last && member.state !== "removed",
          last ? "last-active-admin" : "member-removed",
        ),
        setAdministrator: allowed(
          !last && member.state !== "removed",
          last ? "last-active-admin" : "member-removed",
        ),
        revokeConnections: { allowed: true },
      },
    };
  }

  async #manage(actor: AuthenticatedHuman, workspaceId: WorkspaceId, database = this.#database) {
    const decision = await checkAccess(database, {
      principal: { kind: "person", userId: actor.userId },
      callerKind: "person",
      target: { kind: "project", workspaceId },
      action: "manage",
      ...(actor.authorityGeneration ? { expectedMemberGeneration: actor.authorityGeneration } : {}),
    });
    if (!decision.allowed) refuse("project-manage-required");
  }

  async #rateLimit(procedure: string, context: HostApiServerContext) {
    const key = `team-invitation:${procedure}:${createHash("sha256").update(contextClientAddress(context)).digest("hex")}`;
    if (!(await consumeAnonymousRateLimit(this.#database, key, 60, new Date())))
      throw new OpensteerError({
        code: "resource_exhausted",
        reason: "invite-unavailable",
        message: "Too many invitation attempts; try again later.",
        retryable: false,
      });
    const now = Date.now();
    const prior = this.#publicBudget.get(procedure);
    const budget = !prior || now - prior.at >= 60_000 ? { at: now, remaining: 600 } : prior;
    this.#publicBudget.set(procedure, budget);
    if (budget.remaining-- <= 0)
      throw new OpensteerError({
        code: "resource_exhausted",
        reason: "invite-unavailable",
        message: "Too many invitation attempts; try again later.",
        retryable: false,
      });
  }

  async #invitation(selector: string) {
    const row = await readTeamInvitation(this.#database, selector);
    if (!row) return { state: "unavailable" as const };
    const separator = row.intendedEmail.indexOf("@");
    return {
      state: row.acceptedAt ? ("used" as const) : ("open" as const),
      teamName: this.#teamName,
      inviterName: row.inviterName,
      emailMasked: `${row.intendedEmail.slice(0, 1)}***${row.intendedEmail.slice(separator)}`,
      kind: row.memberKind,
      expiresAt: row.expiresAt.toISOString(),
      signIn: await this.#identity.configuration(),
    };
  }

  async read(
    procedure: Procedure,
    input: unknown,
    context: HostApiServerContext,
  ): Promise<unknown> {
    if (procedure === "team.invitation.preview" || procedure === "team.invitation.exchange") {
      if (context.headers.authorization !== undefined) this.#session(context);
      await this.#authority();
      await this.#rateLimit(procedure, context);
      if (procedure === "team.invitation.preview")
        return this.#invitation(teamReadSchemas[procedure].input.parse(input).selector);
      const parsed = teamReadSchemas[procedure].input.parse(input);
      const result = await this.#identity.exchangeTeamInvitation(
        parsed.selector,
        parsed.verifier,
        headersFrom(context),
      );
      for (const cookie of result.headers.getSetCookie()) context.setHeader("set-cookie", cookie);
      return { preview: await this.#invitation(parsed.selector) };
    }
    if (procedure === "team.invitation.accept") {
      const session = this.#session(context);
      await this.#authority();
      teamReadSchemas[procedure].input.parse(input);
      const proof = await this.#identity.teamInvitationAdmission(headersFrom(context), session);
      const result = await acceptTeamInvitation(this.#database, proof);
      const member = await this.#reads.memberMetadata(session.user.id);
      this.#invalidate([session.user.id]);
      return {
        accessRevision: result.revision,
        member: {
          ...member,
          can: {
            setKind: allowed(false, "team-admin-required"),
            setState: allowed(false, "team-admin-required"),
            setAdministrator: allowed(false, "team-admin-required"),
            revokeConnections: allowed(false, "team-admin-required"),
          },
        },
      };
    }
    const { actor, user, activeAdmins } = await this.#human(context);
    const admin = user.instanceRole === "administrator";
    switch (procedure) {
      case "team.invitations.list":
        return this.#reads.invitations(actor, teamReadSchemas[procedure].input.parse(input));
      case "team.summary.get": {
        const parsed = teamReadSchemas[procedure].input.parse(input);
        const summary = await this.#reads.summary(actor, this.#teamName, parsed.knownRevision);
        if ("notModified" in summary) return summary;
        return {
          ...summary,
          projects: summary.projects.map((project) => ({ ...project, canOpen: { allowed: true } })),
          can: {
            createProject: allowed(user.memberKind === "full", "team-admin-required"),
            people: allowed(admin, "team-admin-required"),
            groups: allowed(admin, "team-admin-required"),
            audit: allowed(admin, "team-admin-required"),
            invite: allowed(admin, "team-admin-required"),
          },
        };
      }
      case "team.people.list": {
        const page = await this.#reads.people(actor, teamReadSchemas[procedure].input.parse(input));
        return { ...page, items: page.items.map((member) => this.#member(member, activeAdmins)) };
      }
      case "team.member.get": {
        const member = await this.#reads.member(
          actor,
          teamReadSchemas[procedure].input.parse(input),
        );
        return {
          ...member,
          can: this.#member(member, activeAdmins, admin).can,
          directEntries: {
            ...member.directEntries,
            items: member.directEntries.items.map((entry) => ({
              ...entry,
              can: {
                change: allowed(admin, "team-admin-required"),
                revoke: allowed(admin, "team-admin-required"),
              },
            })),
          },
          connections: {
            ...member.connections,
            items: member.connections.items.map((connection) => ({
              id: connection.id,
              label: connection.label,
              createdAt: connection.createdAt.toISOString(),
              lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
              revoked: !!connection.revokedAt,
              canRevoke: allowed(!connection.revokedAt, "connection-revoked"),
            })),
          },
        };
      }
      case "team.directory.search":
        return this.#reads.directory(actor, teamReadSchemas[procedure].input.parse(input));
      case "team.groups.list": {
        const result = await this.#reads.groups(
          actor,
          teamReadSchemas[procedure].input.parse(input),
        );
        return { ...result, can: { create: { allowed: true } } };
      }
      case "team.group.get": {
        const result = await this.#reads.groups(
          actor,
          teamReadSchemas[procedure].input.parse(input),
        );
        if (!("builtin" in result)) refuse("team-object-unavailable", "not_found");
        const edit = allowed(!result.builtin, "immutable-everyone");
        return { ...result, can: { rename: edit, editMembers: edit, delete: edit } };
      }
      case "team.project.access.get": {
        const result = await this.#reads.project(
          actor,
          teamReadSchemas[procedure].input.parse(input),
          this.#runnerIsConnected,
        );
        const use = result.audience.myLevel !== null;
        const manage = result.audience.myLevel === "manage";
        return {
          ...result,
          entries: result.entries
            ? {
                ...result.entries,
                items: result.entries.items.map((entry) => ({
                  ...entry,
                  can: { change: { allowed: true }, revoke: { allowed: true } },
                })),
              }
            : null,
          can: {
            use: allowed(use, "membership-lost"),
            manage: allowed(manage, "project-manage-required"),
            addPeople: allowed(manage || admin, "project-manage-required"),
            editInstructions: allowed(manage, "project-manage-required"),
            appointManager: allowed(manage || admin, "project-manage-required"),
            selfGrant: allowed(admin && !use, "team-admin-required"),
          },
        };
      }
      case "team.access.explain": {
        const result = await this.#reads.explain(
          actor,
          teamReadSchemas[procedure].input.parse(input),
        );
        const manage = (
          await checkAccess(this.#database, {
            principal: { kind: "person", userId: actor.userId },
            callerKind: "person",
            target: result.target,
            action: "manage",
          })
        ).allowed;
        return {
          ...result,
          entries: result.entries.map((entry) => ({
            ...entry,
            can: {
              change: allowed(manage || admin, "project-manage-required"),
              revoke: allowed(manage || admin, "project-manage-required"),
            },
          })),
        };
      }
      case "team.access.preview": {
        const parsed = teamReadSchemas[procedure].input.parse(input);
        return previewAccess(this.#database, {
          actor,
          expectedRevision: parsed.expectedRevision,
          commandIdentity: createId("command"),
          changes: parsed.changes,
        });
      }
      case "team.member.preview": {
        const parsed = teamReadSchemas[procedure].input.parse(input);
        const impact = await this.#reads.memberImpact(actor, parsed.userId);
        const preview = await previewMemberAccess(this.#database, {
          actor,
          expectedRevision: impact.accessRevision,
          commandIdentity: createId("command"),
          changes: [memberChange(parsed.userId, parsed.change)],
        });
        return {
          ...impact,
          ...preview,
        };
      }
      case "team.audit.list":
        return this.#reads.audit(actor, teamReadSchemas[procedure].input.parse(input));
      case "team.project.settings.get": {
        const parsed = teamReadSchemas[procedure].input.parse(input);
        return this.#database
          .transaction()
          .setIsolationLevel("repeatable read")
          .setAccessMode("read only")
          .execute(async (database) => {
            await this.#manage(actor, parsed.workspaceId, database);
            const settings = await getProjectRuntimeSettings(database, parsed.workspaceId);
            const runtime = await resolveProjectRuntime(
              database,
              parsed.workspaceId,
              this.#runnerIsConnected,
            );
            return {
              settings: settings
                ? { ...settings, updatedAt: settings.updatedAt.toISOString() }
                : null,
              runtime: runtime.state === "ready" ? { state: "ready" } : runtime,
              can: { edit: { allowed: true } },
            };
          });
      }
      case "team.project.runtimeChoices": {
        const parsed = teamReadSchemas[procedure].input.parse(input);
        return this.#database
          .transaction()
          .setIsolationLevel("repeatable read")
          .setAccessMode("read only")
          .execute(async (database) => {
            await this.#manage(actor, parsed.workspaceId, database);
            const rows = await database
              .selectFrom("workspaces")
              .innerJoin(
                "harnessInstances",
                "harnessInstances.environmentId",
                "workspaces.ownerEnvironmentId",
              )
              .innerJoin(
                "executionEnvironments",
                "executionEnvironments.id",
                "harnessInstances.environmentId",
              )
              .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
              .innerJoin(
                "harnessCatalogs",
                "harnessCatalogs.harnessInstanceId",
                "harnessInstances.id",
              )
              .select([
                "harnessInstances.id",
                "harnessInstances.driverKind",
                "harnessInstances.name",
                "harnessCatalogs.catalog",
              ])
              .where("workspaces.id", "=", parsed.workspaceId)
              .where("runners.ownerKind", "=", "deployment")
              .where("runners.revokedAt", "is", null)
              .where("harnessInstances.enabled", "=", true)
              .where("harnessInstances.removedAt", "is", null)
              .where("harnessInstances.stateKind", "=", "isolated")
              .where("harnessInstances.driverKind", "in", [
                HarnessIdSchema.parse("claude"),
                HarnessIdSchema.parse("codex"),
              ])
              .orderBy("harnessInstances.id")
              .limit(100)
              .execute();
            const instances = rows.flatMap((row) => {
              const catalog = HarnessInstanceCatalogSchema.parse(row.catalog);
              if (
                catalog.status !== "ready" ||
                catalog.harnessInstanceId !== row.id ||
                catalog.driverKind !== row.driverKind
              )
                return [];
              return [
                {
                  id: row.id,
                  driverKind: row.driverKind,
                  name: row.name,
                  models: catalog.models
                    .slice(0, 2000)
                    .map((model) =>
                      storedModelSelection(
                        { modelId: model.modelId, providerId: model.providerId, options: {} },
                        model,
                      ),
                    ),
                },
              ];
            });
            return {
              instances,
              revision: createHash("sha256").update(JSON.stringify(instances)).digest("base64url"),
            };
          });
      }
    }
  }

  async command(input: TeamCommand, context: HostApiServerContext) {
    const { actor, user } = await this.#human(context);
    const command = TeamCommandSchema.parse(input);
    const identity = `${actor.userId}:${command.type}:${command.idempotencyKey}`;
    const commandId = CommandIdSchema.parse(`cmd_${uuidFor(identity)}`);
    const base = { type: command.type, commandId };
    const administratorOnly =
      command.type === "team.member.change" ||
      command.type === "team.access.selfGrant" ||
      command.type === "team.invitation.create" ||
      command.type === "team.invitation.revoke" ||
      (command.type === "team.access.apply" &&
        command.changes.some((change) => change.kind !== "grant" && change.kind !== "revoke"));
    if (administratorOnly && user.instanceRole !== "administrator") {
      const receipt = await this.#database
        .selectFrom("securityAudit")
        .select("id")
        .where("action", "=", "access.mutated")
        .where("requestId", "=", commandId)
        .where("actorUserId", "=", actor.userId)
        .executeTakeFirst();
      if (!receipt) refuse("team-admin-required");
    }
    if (command.type === "team.project.settings.set") {
      const settings = await setProjectRuntimeSettings(this.#database, actor, {
        ...command.settings,
        workspaceId: command.workspaceId,
        expectedAccessRevision: command.expectedRevision,
        expectedSettingsRevision: command.expectedSettingsRevision,
        commandIdentity: commandId,
      });
      this.#invalidate([actor.userId]);
      return TeamCommandResultSchema.parse({
        ...base,
        accessRevision: command.expectedRevision,
        settings: { ...settings, updatedAt: settings.updatedAt.toISOString() },
      });
    }
    if (command.type === "team.invitation.create" || command.type === "team.invitation.revoke") {
      const result = await mutateTeamInvitation(this.#database, actor, command);
      return TeamCommandResultSchema.parse({
        ...base,
        accessRevision: result.accessRevision,
        ...result.result,
      });
    }
    if (command.type === "team.connection.revoke") {
      const result = await revokeTeamConnection(this.#database, actor, command);
      this.#invalidate([actor.userId]);
      return TeamCommandResultSchema.parse({ ...base, ...result });
    }
    let changes: readonly AccessMutation[];
    let projectId: WorkspaceId | undefined;
    const entryId = uuidFor(`${identity}:entry`);
    switch (command.type) {
      case "team.project.create": {
        if (user.memberKind !== "full") refuse("team-admin-required");
        const environments = await this.#database
          .selectFrom("executionEnvironments")
          .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
          .select("executionEnvironments.id")
          .where("runners.ownerKind", "=", "deployment")
          .where("runners.revokedAt", "is", null)
          .where("executionEnvironments.kind", "=", "main")
          .orderBy("executionEnvironments.id")
          .limit(2)
          .execute();
        if (environments.length !== 1) refuse("team-object-unavailable", "not_found");
        projectId = WorkspaceIdSchema.parse(`wsp_${uuidFor(`${identity}:project`)}`);
        changes = [
          {
            kind: "create-project",
            workspaceId: projectId,
            entryId,
            name: command.name,
            color: command.color,
            backing: {
              kind: "local-directory",
              bindingId: WorkspaceBindingIdSchema.parse(`wbd_${uuidFor(`${identity}:binding`)}`),
              generation: 1,
              ownerEnvironmentId: environments[0]!.id,
              storageAuthorityId: null,
            },
          },
        ];
        break;
      }
      case "team.access.apply":
        changes = command.changes;
        break;
      case "team.access.selfGrant":
        changes = [
          {
            kind: "grant",
            id: entryId,
            subject: { kind: "person", userId: actor.userId },
            target: { kind: "project", workspaceId: command.workspaceId },
            level: "use",
          },
        ];
        break;
      case "team.member.change":
        changes = [memberChange(command.userId, command.change)];
        break;
    }
    const result = await mutateAccess(this.#database, {
      actor,
      expectedRevision: command.expectedRevision,
      commandIdentity: commandId,
      changes,
    });
    this.#invalidate([
      ...new Set([actor.userId, ...result.transitions.map((transition) => transition.userId)]),
    ]);
    switch (command.type) {
      case "team.project.create":
        return TeamCommandResultSchema.parse({
          ...base,
          accessRevision: result.revision,
          projectId,
        });
      case "team.access.apply":
        return TeamCommandResultSchema.parse({
          ...base,
          accessRevision: result.revision,
          transitions: result.transitions,
        });
      case "team.access.selfGrant":
        return TeamCommandResultSchema.parse({
          ...base,
          accessRevision: result.revision,
          entryId,
          level: "use",
        });
      case "team.member.change": {
        const member = await this.#reads.memberMetadata(command.userId);
        const viewer =
          command.userId === actor.userId ? member : await this.#reads.memberMetadata(actor.userId);
        const count = await this.#database
          .selectFrom("users")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("instanceRole", "=", "administrator")
          .where("memberState", "=", "active")
          .where("admittedAt", "is not", null)
          .executeTakeFirstOrThrow();
        return TeamCommandResultSchema.parse({
          ...base,
          accessRevision: result.revision,
          member: this.#member(
            member,
            Number(count.count),
            viewer.administrator && viewer.state === "active",
          ),
          effects: "queued",
        });
      }
    }
  }
}
