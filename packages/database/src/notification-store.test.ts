import { createId, type UserId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  requestNotificationAudience,
  type NotificationAudienceMember,
} from "./notification-store.js";

const requester = createId("user");
const owner = createId("user");
const administrator = createId("user");
const stranger = createId("user");

const members: readonly NotificationAudienceMember[] = [
  { instanceRole: "user", role: "collaborator", userId: requester },
  { instanceRole: "user", role: "owner", userId: owner },
  { instanceRole: "administrator", role: "collaborator", userId: administrator },
];
const harnessPayload = { kind: "harness.approval" } as const;

describe("requestNotificationAudience", () => {
  it("tells only the requester when the Request is theirs to answer", () => {
    expect(
      requestNotificationAudience({
        members,
        payload: harnessPayload,
        requestedBy: requester,
        requiredActor: "requester",
      }),
    ).toEqual([requester]);
  });

  it("tells the Workspace owners when ownership is what the Request needs", () => {
    expect(
      requestNotificationAudience({
        members,
        payload: harnessPayload,
        requestedBy: requester,
        requiredActor: "workspace-owner",
      }),
    ).toEqual([owner]);
  });

  it("tells the administrators who are members of this Workspace", () => {
    expect(
      requestNotificationAudience({
        members,
        payload: harnessPayload,
        requestedBy: requester,
        requiredActor: "administrator",
      }),
    ).toEqual([administrator]);
  });

  it("tells nobody once the requester has lost their membership", () => {
    const remaining = members.filter((member) => member.userId !== requester);

    expect(
      requestNotificationAudience({
        members: remaining,
        payload: harnessPayload,
        requestedBy: requester,
        requiredActor: "requester",
      }),
    ).toEqual([]);
  });

  it("never reaches somebody the Workspace does not list", () => {
    for (const requiredActor of ["requester", "workspace-owner", "administrator"] as const) {
      const audience: readonly UserId[] = requestNotificationAudience({
        members,
        payload: harnessPayload,
        requestedBy: requester,
        requiredActor,
      });

      expect(audience).not.toContain(stranger);
    }
  });

  it("tells the Mac's owner, not the Workspace's, about an app waiting on their Mac", () => {
    // In a shared Workspace a collaborator's task asks for an app on that
    // collaborator's own Mac: they approve it there, and the Workspace owner
    // has nothing to answer.
    expect(
      requestNotificationAudience({
        members,
        payload: {
          access: "read",
          app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
          definitionId: "macos-app",
          kind: "computer.app.access",
          reason: "Read the note",
          runnerId: createId("runner"),
          setupRequestId: "00000000-0000-4000-8000-000000000001",
          workspaceId: createId("workspace"),
        },
        requestedBy: requester,
        requiredActor: "requester",
      }),
    ).toEqual([requester]);
  });

  it("keeps bound integration access requester-only", () => {
    expect(
      requestNotificationAudience({
        members,
        payload: {
          access: "read",
          installationId: "iin_00000000-0000-4000-8000-000000000001",
          kind: "integration.access",
          manifest: null,
          reason: "Read the calendar",
          requestedConnectionId: null,
          requestedServerId: null,
        },
        requestedBy: requester,
        requiredActor: "requester",
      }),
    ).toEqual([requester]);
  });
});
