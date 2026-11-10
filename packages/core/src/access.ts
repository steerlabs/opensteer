import type { CommandId, UserId, WorkspaceId } from "./ids.js";
import type { MarkColor } from "./marks.js";
import type { WorkspaceBacking } from "./models.js";

export type AccessPrincipal =
  | { readonly kind: "person"; readonly userId: UserId }
  | { readonly kind: "project"; readonly workspaceId: WorkspaceId };

export type AccessSubject = AccessPrincipal | { readonly kind: "group"; readonly groupId: string };

export type AccessTarget =
  | { readonly kind: "project"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "topic"; readonly topicId: string }
  | { readonly kind: "team-account"; readonly accountId: string };

export type ProjectAccessLevel = "use" | "manage";
export type TopicAccessLevel = "read" | "write" | "manage";
export type TeamAccountAccessLevel = "use";
export type AccessAction = "inspect" | "use" | "read" | "write" | "manage" | "administer";

export type AccessMutation =
  | {
      readonly kind: "create-project";
      readonly workspaceId: WorkspaceId;
      readonly entryId: string;
      readonly name: string;
      readonly color: MarkColor;
      readonly backing: WorkspaceBacking;
    }
  | {
      readonly kind: "create-group";
      readonly id: string;
      readonly name: string;
      readonly builtin?: "everyone";
    }
  | { readonly kind: "delete-group"; readonly groupId: string }
  | { readonly kind: "rename-group"; readonly groupId: string; readonly name: string }
  | {
      readonly kind: "add-group-member" | "remove-group-member";
      readonly groupId: string;
      readonly member: Exclude<AccessSubject, { kind: "project" }>;
    }
  | {
      readonly kind: "grant";
      readonly id: string;
      readonly subject: AccessSubject;
      readonly target: AccessTarget;
      readonly level: ProjectAccessLevel | TopicAccessLevel;
    }
  | { readonly kind: "revoke"; readonly entryId: string }
  | {
      readonly kind: "member";
      readonly userId: UserId;
      readonly memberKind?: "full" | "guest";
      readonly memberState?: "active" | "suspended" | "removed";
      readonly admit?: boolean;
      readonly administrator?: boolean;
    }
  | {
      readonly kind: "delete-project";
      readonly workspaceId: WorkspaceId;
      readonly purgeAfter: Date;
    };

export interface AuthenticatedHuman {
  readonly userId: UserId;
  readonly authorityGeneration?: number;
  readonly sessionId?: import("./ids.js").AuthSessionId;
}

export interface AccessMutationInput {
  readonly actor: AuthenticatedHuman;
  readonly expectedRevision: number;
  readonly commandIdentity: CommandId;
  readonly changes: readonly AccessMutation[];
}

export type AccessDecision =
  | { readonly allowed: false }
  | {
      readonly allowed: true;
      readonly memberGeneration?: number;
      readonly membershipGeneration?: number;
    };
