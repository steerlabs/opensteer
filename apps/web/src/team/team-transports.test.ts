// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { MockTeamHost, TeamRuntimeOwner, TeamSessionClient } from "@opensteer/client/team";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { desktopTeamSession, localTeamPersistence } from "./team-transports.js";

it.each(["same", "different", "stale-scope"])(
  "migrates desktop legacy state only after matching authenticated bootstrap (%s)",
  async (viewer) => {
    const host = new MockTeamHost();
    const legacyScope = { teamDeploymentId: host.teamId, userId: host.userId };
    const scope = {
      ...legacyScope,
      userId: viewer === "different" ? createId("user") : host.userId,
    };
    const owner = new TeamRuntimeOwner({
      issuer: "https://account.test",
      subject: viewer === "same" ? "A" : "B",
    });
    const saved = {
      drafts: { channel: "Upgrade draft" },
      pending: [
        {
          command: {
            type: "team.message.send" as const,
            channelId: createId("teamChannel"),
            threadRootId: null,
            clientMessageId: crypto.randomUUID(),
            bodyMarkdown: "Upgrade pending send",
            mentions: [],
            attachmentIds: [],
          },
          createdAt: new Date().toISOString(),
          failure: null,
        },
      ],
    };
    await localTeamPersistence.save(legacyScope, saved);
    const bootstrap = {
      ...host.bootstrap,
      member: {
        ...host.bootstrap.member,
        userId: viewer === "stale-scope" ? createId("user") : scope.userId,
      },
    };
    const session = new TeamSessionClient({
      ...desktopTeamSession({
        scope,
        owner,
        origin: host.origin,
        bridge: { onHostWebSocketEvent: () => () => {} } as unknown as OpensteerDesktopBridge,
      }),
      rpc: new Proxy(host.rpc, {
        get: (target, key) =>
          key === "team.bootstrap.get"
            ? async () => ({ ok: true, data: bootstrap })
            : Reflect.get(target, key),
      }),
      connect: host.connect,
    });
    try {
      await session.load(false);
      expect(session.getSnapshot()).toMatchObject(
        viewer === "same" ? saved : { drafts: {}, pending: [] },
      );
      expect(await localTeamPersistence.load(legacyScope)).toEqual(
        viewer === "same" ? null : saved,
      );
    } finally {
      session.dispose();
      owner.retire();
      host.dispose();
      localStorage.clear();
    }
  },
);
