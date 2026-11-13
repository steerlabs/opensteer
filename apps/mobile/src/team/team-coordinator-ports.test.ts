import { HostClientRequestError, type HostClient } from "@opensteer/client/host";
import { mockAccountSubject, type TeamConnectionIntent } from "@opensteer/client/team";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { DeploymentIdSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { fileTeamIntentStore, mobilePersonalTeamLinks } from "./team-coordinator-ports.js";

const personal = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000cc");
const intent = (teamOrigin: string): TeamConnectionIntent => ({
  accountSubject: mockAccountSubject,
  teamOrigin,
  teamDeploymentId: null,
  hostedTeamId: null,
  personalDeploymentId: personal,
  state: "connecting",
  failure: null,
  updatedAt: new Date(0).toISOString(),
});

describe("phone team ports", () => {
  it("keeps every intent that still parses, across a restart", async () => {
    const files = new MemoryPrivateFilesystem();
    const path = `${files.root}/team-intents.json`;
    await files.writeFileAtomic(
      path,
      JSON.stringify({
        schemaVersion: 1,
        intents: [intent("https://acme.teams.opensteer.com"), { teamOrigin: "not an intent" }],
      }),
    );
    const store = fileTeamIntentStore(files, path);
    expect(await store.load()).toEqual([intent("https://acme.teams.opensteer.com")]);
    await store.save(intent("https://beta.teams.opensteer.com"));
    await store.remove({
      accountSubject: mockAccountSubject,
      teamOrigin: "https://acme.teams.opensteer.com",
    });
    expect(await fileTeamIntentStore(files, path).load()).toEqual([
      intent("https://beta.teams.opensteer.com"),
    ]);
  });

  it("treats an unreachable or unshown computer as offline, and a refusal as a refusal", async () => {
    const answering = (failure: Error): HostClient =>
      ({
        rpc: { "commands.dispatch": () => Promise.reject(failure) },
      }) as unknown as HostClient;
    const offline = mobilePersonalTeamLinks(() =>
      answering(new TypeError("Network request failed")),
    );
    expect(await offline.join(personal, "offer")).toEqual({ kind: "offline" });
    expect(await mobilePersonalTeamLinks(() => null).join(personal, "offer")).toEqual({
      kind: "offline",
    });
    const refused = mobilePersonalTeamLinks(() =>
      answering(
        new HostClientRequestError({
          code: "bad_request",
          message: "That code expired.",
          status: 400,
        }),
      ),
    );
    await expect(refused.join(personal, "offer")).rejects.toThrow("That code expired.");
  });

  it("never reports leaving a team on a computer it couldn't ask", async () => {
    const team = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000dd");
    await expect(mobilePersonalTeamLinks(() => null).leave(personal, team)).rejects.toThrow(
      /isn’t reachable/u,
    );
  });
});
