import { createId, parseTeamPageLink, teamPageAppLink } from "@opensteer/core";
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { expect, it, vi } from "vitest";
import { DesktopTeamLinks } from "../../app/team-links.js";
import type { DesktopBridgeContext } from "../context.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import { teamLinkDelivery } from "./team-links.js";

it("delivers pending team links only to the ready application window and retains them across navigation", () => {
  const scheme = "com.opensteer.opensteer";
  const teamLinks = new DesktopTeamLinks(scheme);
  const page = `https://unknown.example/c/${createId("teamChannel")}/m/42`;
  teamLinks.accept(teamPageAppLink(parseTeamPageLink(page)!, scheme));
  const mainFrame = { url: "app://opensteer/" };
  const sender = Object.assign(new EventEmitter(), {
    mainFrame,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const context = {
    options: {
      bridgeToken: "fixture",
      teamLinks,
      isWorkspaceContents: (candidate: unknown) => candidate === sender,
    },
  } as unknown as DesktopBridgeContext;
  const owner = teamLinkDelivery(context);
  const ready = { bridgeToken: "fixture", input: { ready: true } };
  try {
    expect(() => owner.handle(event, { ...ready, bridgeToken: "wrong" })).toThrow("capability");
    const panelFrame = { url: "app://opensteer/settings" };
    expect(() =>
      owner.handle(
        {
          sender: { mainFrame: panelFrame },
          senderFrame: panelFrame,
        } as unknown as IpcMainInvokeEvent,
        ready,
      ),
    ).toThrow("application window");
    expect(sender.send).not.toHaveBeenCalled();
    owner.handle(event, ready);
    const link = sender.send.mock.calls[0]![1];
    expect(sender.send).toHaveBeenCalledWith(desktopBridgeChannels.teamLink, {
      id: link.id,
      url: page,
    });
    sender.emit("did-navigate");
    owner.handle(event, ready);
    expect(sender.send.mock.calls[1]![1]).toEqual(link);
    owner.handle(event, {
      bridgeToken: "fixture",
      input: { ready: true, acknowledgedId: link.id },
    });
    owner.dispose();
    owner.handle(event, ready);
    expect(sender.send).toHaveBeenCalledTimes(2);
  } finally {
    owner.dispose();
  }
});
