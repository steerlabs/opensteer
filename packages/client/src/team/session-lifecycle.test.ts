import { createId, TeamBlobIdSchema, TeamChannelIdSchema } from "@opensteer/core";
import { TeamFileSchema, hostApi } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import { MockTeamHost, mockTeamChannelId, mockTeamId, mockTeamUserId } from "./mock-team-host.js";
import { TeamSessionClient, type TeamSessionOptions } from "./team-session-client.js";
import { TeamTransportRegistry } from "./transport-registry.js";
import { createMemoryTeamPersistence } from "./persistence.js";

const scope = { teamDeploymentId: mockTeamId, userId: mockTeamUserId };
it("keeps every desktop sidebar connected but only the selected mobile team connected, even after a late bootstrap", async () => {
  const a = new MockTeamHost(),
    b = new MockTeamHost({ teamId: createId("deployment") });
  const hosts = new Map([
      [a.teamId, a],
      [b.teamId, b],
    ]),
    persistence = createMemoryTeamPersistence();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const mobile = new TeamTransportRegistry("mobile", (selected) => {
    const host = hosts.get(selected.teamDeploymentId as typeof mockTeamId)!;
    const rpc = {
      ...host.rpc,
      "team.bootstrap.get": async () => {
        if (host === a) await gate;
        return host.rpc["team.bootstrap.get"]({});
      },
    };
    // Proxy clients expose methods lazily; retain the rest of that contract.
    return {
      scope: selected,
      persistence,
      connect: host.connect,
      rpc: new Proxy(host.rpc, {
        get: (target, name) =>
          name === "team.bootstrap.get" ? rpc["team.bootstrap.get"] : Reflect.get(target, name),
      }),
    };
  });
  const desktop = new TeamTransportRegistry("desktop", (selected) => {
    const host = hosts.get(selected.teamDeploymentId as typeof mockTeamId)!;
    return { scope: selected, persistence, rpc: host.rpc, connect: host.connect };
  });
  try {
    await mobile.join(scope);
    await mobile.join({ ...scope, teamDeploymentId: b.teamId });
    expect(a.socketCount + b.socketCount).toBe(0);
    const old = mobile.select(scope);
    await mobile.select({ ...scope, teamDeploymentId: b.teamId });
    finish();
    await old;
    expect(a.socketCount).toBe(0);
    expect(b.socketCount).toBe(1);
    await mobile.select(null);
    expect(b.socketCount).toBe(0);
    await Promise.all([
      desktop.join(scope),
      desktop.join({ ...scope, teamDeploymentId: b.teamId }),
    ]);
    expect(a.socketCount).toBe(1);
    expect(b.socketCount).toBe(1);
    await desktop.select(scope);
    expect(a.socketCount).toBe(1);
    expect(b.socketCount).toBe(1);
  } finally {
    finish();
    mobile.dispose();
    desktop.dispose();
    a.dispose();
    b.dispose();
  }
});
it("fences a page from the channel that was selected before it finished", async () => {
  const host = new MockTeamHost(),
    persistence = createMemoryTeamPersistence();
  let finish!: (value: Awaited<ReturnType<(typeof host.rpc)["team.messages.page"]>>) => void;
  const response = new Promise<Awaited<ReturnType<(typeof host.rpc)["team.messages.page"]>>>(
    (resolve) => {
      finish = resolve;
    },
  );
  const rpc = new Proxy(host.rpc, {
    get: (target, name) =>
      name === "team.messages.page" ? () => response : Reflect.get(target, name),
  });
  const client = new TeamSessionClient({ scope, persistence, rpc, connect: host.connect });
  try {
    await client.load();
    client.selectChannel(mockTeamChannelId);
    const page = client.loadPage("channel", "newest"),
      old = host.channels.get(mockTeamChannelId)!;
    const other = TeamChannelIdSchema.parse(createId("teamChannel"));
    host.channels.set(other, { ...old, id: other, name: "other" });
    client.selectChannel(other);
    finish({
      ok: true,
      data: hostApi["team.messages.page"].success.parse({
        channel: old,
        messages: [],
        hasMore: true,
        throughSeq: "99",
      }),
    });
    await page;
    expect(client.getSnapshot().channel?.scope.channelId).toBe(other);
    expect(client.getSnapshot().channel?.hasMore).toBe(false);
    expect(client.getSnapshot().channel?.throughSeq).toBe("0");
  } finally {
    client.dispose();
    host.dispose();
  }
});
it("loads previews first, reads originals only on open and drops late file results after removal", async () => {
  const host = new MockTeamHost(),
    persistence = createMemoryTeamPersistence(),
    readFile = vi.fn<NonNullable<TeamSessionOptions["readFile"]>>(async () => new Blob(["image"]));
  const client = new TeamSessionClient({
    scope,
    persistence,
    rpc: host.rpc,
    connect: host.connect,
    readFile,
  });
  const file = TeamFileSchema.parse({
    id: TeamBlobIdSchema.parse(createId("teamBlob")),
    channelId: mockTeamChannelId,
    filename: "photo.png",
    mediaType: "image/png",
    sizeBytes: 5,
    sha256: "a".repeat(64),
    preview: { mediaType: "image/png", sizeBytes: 5 },
  });
  try {
    await client.file(file);
    await client.file(file);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile.mock.calls[0]?.[1]).toBe("preview");
    await client.file(file, true);
    expect(readFile.mock.calls[1]?.[1]).toBe("original");
    let finish!: (blob: Blob) => void;
    readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = client.file({ ...file, id: TeamBlobIdSchema.parse(createId("teamBlob")) });
    await client.remove();
    finish(new Blob(["late"]));
    expect(await loading).toBeNull();
  } finally {
    client.dispose();
    host.dispose();
  }
});
it("takes a bounded replacement snapshot once more than two hundred current rows changed", async () => {
  const host = new MockTeamHost();
  try {
    for (let index = 0; index < 201; index++)
      await host.read("commands.dispatch", {
        type: "team.message.send",
        channelId: mockTeamChannelId,
        threadRootId: null,
        clientMessageId: crypto.randomUUID(),
        bodyMarkdown: `Message ${index}`,
        mentions: [],
        attachmentIds: [],
      });
    const cut = host.cut({ kind: "channel", channelId: mockTeamChannelId }, "channel", 1, "0");
    expect(cut.type).toBe("snapshot");
    if (cut.type !== "snapshot") throw new Error("Expected snapshot");
    expect(cut.messages).toHaveLength(50);
    expect(cut.hasMore).toBe(true);
    expect(cut.throughSeq).toBe("201");
  } finally {
    host.dispose();
  }
});
it("checks persisted pending ids after restarting the client before it resends", async () => {
  const host = new MockTeamHost(),
    persistence = createMemoryTeamPersistence();
  const first = new TeamSessionClient({ scope, persistence, rpc: host.rpc, connect: host.connect });
  let second: TeamSessionClient | undefined;
  try {
    await first.load();
    await vi.waitFor(() => expect(first.getSnapshot().connection).toBe("connected"));
    host.loseNextSendAck = true;
    await first.send({
      channelId: mockTeamChannelId,
      threadRootId: null,
      bodyMarkdown: "Once",
      mentions: [],
      attachmentIds: [],
    });
    await vi.waitFor(() => expect(first.getSnapshot().error).toBe("Acknowledgement lost."), {
      timeout: 1000,
    });
    expect(first.getSnapshot().pending).toHaveLength(1);
    first.dispose();
    const offset = host.calls.length;
    second = new TeamSessionClient({ scope, persistence, rpc: host.rpc, connect: host.connect });
    await second.load();
    await vi.waitFor(() =>
      expect(second!.getSnapshot().pending, "persisted send was never confirmed").toHaveLength(0),
    );
    expect(host.calls.slice(offset)).toEqual(["team.bootstrap.get", "team.messages.check"]);
    expect(host.messages.size).toBe(1);
  } finally {
    first.dispose();
    second?.dispose();
    host.dispose();
  }
});
it("raises sidebar notifications according to the Host's mention and mute facts", async () => {
  const host = new MockTeamHost(),
    notify = vi.fn(),
    client = new TeamSessionClient({
      scope,
      persistence: createMemoryTeamPersistence(),
      rpc: host.rpc,
      connect: host.connect,
      notify,
    });
  const post = (mentions: { userId: typeof mockTeamUserId; kind: "person" }[]) =>
    host.read("commands.dispatch", {
      type: "team.message.send",
      channelId: mockTeamChannelId,
      threadRootId: null,
      clientMessageId: crypto.randomUUID(),
      bodyMarkdown: "Update",
      mentions,
      attachmentIds: [],
    });
  try {
    await client.load();
    await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"));
    await post([]);
    expect(notify).not.toHaveBeenCalled();
    await post([{ userId: mockTeamUserId, kind: "person" }]);
    expect(notify).toHaveBeenCalledTimes(1);
    await host.read("commands.dispatch", {
      type: "team.channel.preferences.set",
      channelId: mockTeamChannelId,
      notificationLevel: "muted",
    });
    await post([{ userId: mockTeamUserId, kind: "person" }]);
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    client.dispose();
    host.dispose();
  }
});

it("keeps Personal and Team attachments alive together with independent durable positions", async () => {
  const { MockHostClient } = await import("../mock/mock-host-client.js");
  const { MockPersonalHost } = await import("../mock/mock-personal-host.js");
  const { HttpHostClient } = await import("../host/host-session-client.js");
  const personalHost = new MockPersonalHost(
    new MockHostClient({
      world: "first-run",
      latencyMs: 0,
      places: "absent",
      automations: "absent",
      subagents: "absent",
    }),
  );
  const personal = new HttpHostClient({
    baseUrl: "http://personal",
    fetch: personalHost.fetch,
    webSocketFactory: personalHost.connect,
    refreshIntervalMs: 0,
  });
  const teamHost = new MockTeamHost(),
    team = new TeamSessionClient({
      scope,
      persistence: createMemoryTeamPersistence(),
      rpc: teamHost.rpc,
      connect: teamHost.connect,
    });
  try {
    await Promise.all([personal.load(), team.load()]);
    team.selectChannel(mockTeamChannelId);
    await vi.waitFor(() => {
      expect(personal.deploymentPosition()).toBe("0");
      expect(team.getSnapshot().channel?.throughSeq).toBe("0");
    });
    personalHost.publish([], "47");
    await team.send({
      channelId: mockTeamChannelId,
      threadRootId: null,
      bodyMarkdown: "Team only",
      mentions: [],
      attachmentIds: [],
    });
    expect(personal.deploymentPosition()).toBe("47");
    expect(personal.getSnapshot().tasks?.entries).toEqual([]);
    expect(team.getSnapshot().channel?.throughSeq).toBe("1");
    expect(team.getSnapshot().channel?.messages.map((row) => row.bodyMarkdown)).toEqual([
      "Team only",
    ]);
    expect(personalHost.sockets.size).toBe(1);
    expect(teamHost.socketCount).toBe(1);
    team.dispose();
    expect(personalHost.sockets.size).toBe(1);
  } finally {
    personal.dispose();
    personalHost.dispose();
    team.dispose();
    teamHost.dispose();
  }
});
