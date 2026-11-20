import { createId } from "@opensteer/core";
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
  await expect(client.send({ method: "Storage.getCookies" })).rejects.toThrow(
    "whole browser context",
  );
  await expect(
    client.send({ sessionId, method: "Emulation.setDeviceMetricsOverride" }),
  ).rejects.toThrow("unavailable");
  await router.close();
});

it.each(["binding stop", "unshare", "source disconnect", "client disconnect"] as const)(
  "releases a live shared tab on %s",
  async (ending) => {
    const admitExecution = vi.fn().mockResolvedValue({
      agentConnection: null,
      mode: "full-access",
      runId: null,
    });
    const service = new ChromeSharedTabs({ admitExecution });
    const ownerId = createId("user");
    const sourceId = createId("browserSource");
    const first = shared();
    const second = shared();
    const popup = shared(first.shareId);
    const authority = { agentBindingId: "run:fixture", ownerId };
    const peer = chromePeer((frame) => source.receive(frame));
    const source = service.connectSource({
      ownerId,
      sourceId,
      fail: () => {},
      name: "Chrome",
      write: peer.write,
    });
    source.receive(first);
    source.receive(second);
    const ticket = await service.issueStandardCdpTicket({ authority, tabId: first.shareId });
    const claims = service.standardCdpTickets.consume(ticket.ticket)!;
    const signal = new AbortController();
    const client = await service.attachStandardCdpForAgent(claims, signal.signal);
    source.receive(popup);
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
    admitExecution.mockResolvedValueOnce({ agentConnection: {}, mode: "full-access" });
    await expect(client.reauthorize()).rejects.toThrow("own agents");
    if (ending === "binding stop") service.closeForBinding(authority.agentBindingId, "Stopped");
    else if (ending === "unshare") source.receive({ type: "tab.unshared", shareId: first.shareId });
    else if (ending === "source disconnect") source.close();
    else signal.abort();
    expect(client.signal.aborted).toBe(true);
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
