// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { TeamConnectionIntentSchema } from "@opensteer/client/team";
import { localIntentStore } from "./team-coordination.js";

afterEach(() => localStorage.clear());

const intent = (teamOrigin: string) =>
  TeamConnectionIntentSchema.parse({
    accountSubject: "acct_00000000-0000-4000-8000-000000000001",
    teamOrigin,
    teamDeploymentId: null,
    hostedTeamId: null,
    personalDeploymentId: null,
    state: "no-agent",
    failure: null,
    updatedAt: new Date(0).toISOString(),
  });

it("keeps every intent saved at once, and a removal made meanwhile", async () => {
  await localIntentStore.save(intent("https://gone.teams.opensteer.com"));
  await Promise.all([
    localIntentStore.save(intent("https://acme.teams.opensteer.com")),
    localIntentStore.save(intent("https://beta.teams.opensteer.com")),
    localIntentStore.remove(intent("https://gone.teams.opensteer.com")),
  ]);
  expect((await localIntentStore.load()).map((held) => held.teamOrigin).sort()).toEqual([
    "https://acme.teams.opensteer.com",
    "https://beta.teams.opensteer.com",
  ]);
});
