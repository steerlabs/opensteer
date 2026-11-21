import { AgentGrantSchema, createId } from "@opensteer/core";
import {
  BrowserSourceTabAssembly,
  BrowserSourceTabCommandSchema,
  browserSourceTabBufferedBytes,
  browserSourceTabMessageBytes,
  browserSourceTabPending,
  browserSourceTabParts,
  type BrowserSourceTabCommand,
  type BrowserSourceTabEvent,
  type BrowserSourceTabPart,
  type BrowserSourceTabResult,
  type BrowserSourceTabShared,
} from "@opensteer/browser-source-wire/frames";
import {
  standardCdpBufferedMaxBytes,
  standardCdpMaxPending,
  standardCdpMessageMaxBytes,
} from "@opensteer/protocol/standard-cdp";
import type { OpensteerStore } from "@opensteer/database";
import { SessionCdpRouter } from "@opensteer/browser-runtime-core";
import { expect, it, vi } from "vitest";
import { ChromeSharedTabs } from "./chrome-shared-tabs.js";
import { ChromeTabBackend } from "./chrome-tab-backend.js";

it("shares the standard CDP byte and pending-command budgets", () => {
  expect([
    browserSourceTabMessageBytes,
    browserSourceTabBufferedBytes,
    browserSourceTabPending,
  ]).toEqual([standardCdpMessageMaxBytes, standardCdpBufferedMaxBytes, standardCdpMaxPending]);
});

function shared(openerShareId?: string): BrowserSourceTabShared {
  return {
    type: "tab.shared",
    shareId: crypto.randomUUID(),
    targetId: crypto.randomUUID(),
    title: "Fixture",
    url: "https://example.test/",
    ...(openerShareId ? { openerShareId } : {}),
  };
}

function chromePeer(accept: (frame: BrowserSourceTabPart<"tab.result" | "tab.event">) => void) {
  const commands: BrowserSourceTabCommand[] = [];
  const assembly = new BrowserSourceTabAssembly();
  const onCommand = vi.fn((_command: BrowserSourceTabCommand) => ({}));
  const frame = (
    type: "tab.result" | "tab.event",
    data: BrowserSourceTabEvent | BrowserSourceTabResult,
  ) => {
    for (const part of browserSourceTabParts(type, Buffer.from(JSON.stringify(data)))) accept(part);
  };
  return {
    commands,
    onCommand,
    event: (event: BrowserSourceTabEvent) => frame("tab.event", event),
    write(part: BrowserSourceTabPart<"tab.command">) {
      const raw = assembly.read(part);
      if (raw === undefined) return true;
      const command = BrowserSourceTabCommandSchema.parse(raw);
      commands.push(command);
      const result = onCommand(command);
      const { requestId, shareId, attachmentId } = command;
      queueMicrotask(() =>
        frame("tab.result", { requestId, shareId, attachmentId, ok: true, result }),
      );
      return true;
    },
  };
}

it("answers virtual browser questions and detaches Chrome only after its last logical channel", async () => {
  const tab = shared();
  const peer = chromePeer((frame) => backend.read(frame));
  const backend = new ChromeTabBackend(peer.write, () => {});
  backend.update(tab);
  await expect(backend.send("Target.getBrowserContexts")).resolves.toEqual({
    browserContextIds: [],
  });
  await expect(backend.send("Browser.getVersion")).resolves.toMatchObject({
    protocolVersion: "1.3",
  });
  await expect(
    backend.send("Target.getTargetInfo", { targetId: tab.targetId }),
  ).resolves.toMatchObject({
    targetInfo: { title: tab.title, url: tab.url },
  });
  await expect(backend.send("Target.getTargets")).resolves.toMatchObject({
    targetInfos: [{ targetId: tab.targetId }],
  });
  const left = await backend.attach(tab.targetId);
  const right = await backend.attach(tab.targetId);
  expect(peer.commands).toEqual([]);
  await left.send("Runtime.enable");
  const { attachmentId } = peer.commands[0]!;
  const params = { context: { id: 44 } };
  peer.event({
    shareId: tab.shareId,
    attachmentId,
    method: "Runtime.executionContextCreated",
    params,
  });
  const replay = vi.fn();
  right.onEvent(replay);
  await right.send("Runtime.enable");
  expect(replay).toHaveBeenCalledWith("Runtime.executionContextCreated", params);
  expect(peer.commands).toHaveLength(1);
  await left.close();
  await right.send("Runtime.evaluate", { expression: "1" });
  expect(peer.commands.at(-1)?.attachmentId).toBe(attachmentId);
  await right.close();
  expect(peer.commands.at(-1)).toMatchObject({ action: "detach", attachmentId });
  await expect(backend.send("Target.createTarget")).rejects.toThrow("unavailable");
});

it("bridges nested flat child events through the router without exposing the physical session IDs", async () => {
  const tab = shared();
  const peer = chromePeer((frame) => backend.read(frame));
  const backend = new ChromeTabBackend(peer.write, () => {});
  const router = new SessionCdpRouter(backend);
  router.registerSession("first-share", tab.targetId, async () => false, "/");
  backend.update(tab);
  const client = router.openStandardClient("first-share", { wholeContext: false });
  const events = vi.fn();
  client.onEvent(events);
  const { sessionId } = (await client.send({
    method: "Target.attachToTarget",
    parameters: { targetId: tab.targetId, flatten: true },
  })) as { sessionId: string };
  const autoAttach = (id: string) =>
    client.send({
      sessionId: id,
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    });
  await autoAttach(sessionId);
  const { attachmentId } = peer.commands[0]!;
  expect(peer.commands[0]).toMatchObject({ params: { flatten: true } });
  const child = (physical: string, parent?: string) => {
    peer.event({
      shareId: tab.shareId,
      attachmentId,
      ...(parent ? { sessionId: parent } : {}),
      method: "Target.attachedToTarget",
      params: {
        sessionId: physical,
        waitingForDebugger: false,
        targetInfo: { targetId: physical, type: "iframe" },
      },
    });
    const virtual = events.mock.lastCall?.[0].parameters.sessionId as string;
    expect(virtual).not.toBe(physical);
    return virtual;
  };
  const first = child("flat-first");
  await autoAttach(first);
  const second = child("flat-second", "flat-first");
  await client.send({
    sessionId: second,
    method: "Runtime.evaluate",
    parameters: { expression: "1" },
  });
  expect(peer.commands.at(-1)).toMatchObject({
    method: "Runtime.evaluate",
    sessionId: "flat-second",
    attachmentId,
  });
  await client.send({ sessionId, method: "Network.getAllCookies" });
  expect(peer.commands.at(-1)).toMatchObject({ method: "Network.getAllCookies" });
  for (const method of [
    "Storage.getCookies",
    "Browser.grantPermissions",
    "Browser.setDownloadBehavior",
  ]) {
    await expect(client.send({ method })).rejects.toThrow("whole browser context");
  }
  for (const method of ["Target.createTarget", "Target.closeTarget"]) {
    await expect(client.send({ method })).rejects.toThrow("unavailable");
  }
  await expect(client.send({ sessionId, method: "Page.startScreencast" })).rejects.toThrow(
    "unavailable",
  );
  await expect(
    client.send({ sessionId, method: "Emulation.setDeviceMetricsOverride" }),
  ).rejects.toThrow("unavailable");
  await router.close();
});

it.each(["binding stop", "unshare", "source disconnect", "client disconnect"] as const)(
  "releases a live shared tab on %s",
  async (ending) => {
    const admitExecution = vi.fn<OpensteerStore["admitExecution"]>(
      async ({ ownerUserId, subject }) => ({
        ownerUserId,
        subject,
        actor: "native",
        agentConnection: null,
        mode: "full-access",
        runId: null,
        runMode: null,
        threadId: null,
        taskMode: null,
      }),
    );
    const service = new ChromeSharedTabs({ admitExecution });
    const ownerId = createId("user");
    const sourceId = createId("browserSource");
    const first = shared();
    const second = shared();
    const popup = shared(first.shareId);
    const authority = { agentBindingId: "run:fixture", ownerId };
    const peer = chromePeer((frame) => {
      expect(source.receive(frame)).toBeUndefined();
    });
    const source = service.connectSource({
      ownerId,
      sourceId,
      fail: () => {},
      name: "Chrome",
      write: peer.write,
    });
    await source.receive(first);
    await source.receive(second);
    const ticket = await service.issueStandardCdpTicket({ authority, tabId: first.shareId });
    const claims = service.standardCdpTickets.consume(ticket.ticket)!;
    const signal = new AbortController();
    const client = await service.attachStandardCdpForAgent(claims, signal.signal);
    await source.receive(popup);
    const frame = Promise.withResolvers<Buffer>();
    client.onFrame(frame.resolve);
    await client.send(Buffer.from(JSON.stringify({ id: 1, method: "Target.getTargets" })));
    expect(
      JSON.parse(String(await frame.promise)).result.targetInfos.map(
        ({ targetId }: { targetId: string }) => targetId,
      ),
    ).toEqual([first.targetId, popup.targetId]);
    await expect(
      service.listForBinding({ ...authority, ownerId: createId("user") }),
    ).resolves.toEqual([]);
    admitExecution.mockResolvedValueOnce({
      ...(await admitExecution.mock.results[0]!.value),
      mode: "read-only",
    });
    await expect(client.reauthorize()).rejects.toThrow("access mode");
    let stopping: Promise<void> | undefined;
    if (ending === "binding stop")
      stopping = service.closeForBinding(authority.agentBindingId, "Stopped");
    else if (ending === "unshare")
      expect(source.receive({ type: "tab.unshared", shareId: first.shareId })).toBeUndefined();
    else if (ending === "source disconnect") source.close();
    else signal.abort();
    expect(client.signal.aborted).toBe(true);
    await stopping;
    if (ending === "client disconnect")
      await expect(
        service.issueStandardCdpTicket({ authority, tabId: first.shareId }),
      ).resolves.toMatchObject({ mode: "session" });
    else
      await expect(
        service.issueStandardCdpTicket({ authority, tabId: first.shareId }),
      ).rejects.toThrow("no longer shared");
    service.close();
  },
);

it("checks the current Chrome grant before each command and awaits detach evidence on Stop", async () => {
  const ownerId = createId("user");
  const sourceId = createId("browserSource");
  const deviceId = createId("device");
  const connectionId = "connected-agent";
  const authority = { ownerId, agentBindingId: "session:fixture" };
  const tab = shared();
  let grant = AgentGrantSchema.parse({ scope: "everything" });
  const admitExecution: OpensteerStore["admitExecution"] = async ({ ownerUserId, subject }) => ({
    ownerUserId,
    subject,
    actor: "agent",
    agentConnection: {
      agentConnectionId: connectionId,
      grant,
      grantRevision: 1,
      consentVersion: 2,
      accessMode: "full-access",
    },
    mode: "full-access",
    runId: null,
    threadId: createId("thread"),
    runMode: null,
    taskMode: "full-access",
  });
  const open = vi.fn(async () => {});
  const finish = vi.fn(async () => {});
  const service = new ChromeSharedTabs(
    { admitExecution },
    {
      attempts: { open, finish, recordDetach: async () => {}, recover: async () => {} },
      device: async () => "Work Mac",
    },
  );
  const peer = chromePeer((frame) => {
    expect(source.receive(frame)).toBeUndefined();
  });
  const source = service.connectSource({
    ownerId,
    sourceId,
    deviceId,
    detachReceipts: true,
    fail: () => {},
    name: "Chrome",
    write: peer.write,
  });
  try {
    await source.receive(tab);
    const port = service.browserUsePort(async () => authority, tab.shareId);
    const call = {
      contextKey: "fixture",
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
      maxBytes: 4096,
      maxDepth: 16,
      maxEntries: 256,
    };
    const target = await port.openPage(tab.shareId, call);
    await port.command(target, "Runtime.evaluate", { expression: "1" }, undefined, call);
    expect(open).toHaveBeenCalledOnce();
    expect(peer.commands).toHaveLength(1);
    grant = AgentGrantSchema.parse({ scope: "selected", tasks: false, resources: [] });
    await expect(
      port.command(target, "Runtime.evaluate", { expression: "2" }, undefined, call),
    ).rejects.toThrow("This Chrome tab is no longer shared.");
    expect(peer.commands).toHaveLength(1);
    const stopping = service.closeForBinding(authority.agentBindingId, "Stopped");
    expect(peer.commands).toContainEqual(expect.objectContaining({ action: "unshare" }));
    expect(finish).not.toHaveBeenCalled();
    const revoked = vi.fn();
    const revoking = service.stopSource(sourceId).then(revoked);
    await source.receive(shared());
    grant = AgentGrantSchema.parse({ scope: "everything" });
    await expect(service.listForBinding(authority)).resolves.toEqual([]);
    expect(revoked).not.toHaveBeenCalled();
    const detached = source.receive({ type: "tab.detached", shareId: tab.shareId });
    await Promise.all([stopping, revoking, detached]);
    expect(finish).toHaveBeenCalledExactlyOnceWith(connectionId, expect.any(String), true);
  } finally {
    source.close();
  }
});

it("rejects a stale reviewed Chrome mode at ticket issue, attach, and command dispatch", async () => {
  const ownerId = createId("user");
  const sourceId = createId("browserSource");
  const threadId = createId("thread");
  const authority = { ownerId, agentBindingId: "session:fixture" };
  const tab = shared();
  const agentConnection = {
    agentConnectionId: "connected-agent",
    grant: AgentGrantSchema.parse({ scope: "everything" }),
    grantRevision: 1,
    consentVersion: 2,
    accessMode: "full-access",
  } as const;
  let mode: "full-access" | "approval-required" = "full-access";
  const admitExecution: OpensteerStore["admitExecution"] = async ({ ownerUserId, subject }) => ({
    ownerUserId,
    subject,
    actor: "agent",
    agentConnection,
    mode,
    runId: null,
    threadId,
    runMode: null,
    taskMode: mode,
  });
  const open = vi.fn(async () => {});
  const service = new ChromeSharedTabs(
    { admitExecution },
    {
      attempts: {
        open,
        finish: async () => {},
        recordDetach: async () => {},
        recover: async () => {},
      },
      device: async () => "Work Mac",
    },
  );
  const peer = chromePeer((frame) => {
    expect(source.receive(frame)).toBeUndefined();
  });
  const source = service.connectSource({
    ownerId,
    sourceId,
    deviceId: createId("device"),
    detachReceipts: true,
    fail: () => {},
    name: "Chrome",
    write: peer.write,
  });
  try {
    await source.receive(tab);
    const signal = new AbortController().signal;
    const input = {
      authority,
      tabId: tab.shareId,
      expectedAccess: { accessMode: "full-access", grantRevision: 1 } as const,
    };
    const claims = async () => {
      const { ticket } = await service.issueStandardCdpTicket(input);
      return service.standardCdpTickets.consume(ticket)!;
    };
    const beforeLowering = await claims();
    const stale = await claims();
    const client = await service.attachStandardCdpForAgent(beforeLowering, signal);
    const reply = Promise.withResolvers<{ result?: { sessionId: string } }>();
    client.onFrame((frame) => {
      const message = JSON.parse(frame.toString("utf8"));
      if (message.id === 1) reply.resolve(message);
    });
    await client.send(
      Buffer.from(
        JSON.stringify({
          id: 1,
          method: "Target.attachToTarget",
          params: { targetId: tab.targetId, flatten: true },
        }),
      ),
    );
    const attached = await reply.promise;
    expect(attached).toMatchObject({ result: { sessionId: expect.any(String) } });
    const sessionId = attached.result!.sessionId;

    mode = "approval-required";
    const ended = {
      name: "BrowserCdpConnectionEnded",
      message: "This browser authority changed. Request a new attachment.",
    };
    await expect(service.issueStandardCdpTicket(input)).rejects.toMatchObject(ended);
    await expect(service.attachStandardCdpForAgent(stale, signal)).rejects.toMatchObject(ended);
    await expect(client.reauthorize()).rejects.toMatchObject(ended);
    await expect(
      client.send(
        Buffer.from(
          JSON.stringify({
            id: 2,
            sessionId,
            method: "Runtime.evaluate",
            params: { expression: "1" },
          }),
        ),
      ),
    ).rejects.toMatchObject(ended);
    expect(peer.commands).toEqual([]);
    expect(open).toHaveBeenCalledOnce();
  } finally {
    source.close();
  }
});
