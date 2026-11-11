import { expect, test, vi } from "vitest";
import { PhoneCdpSession, type PhoneCdpOwner } from "./cdp.js";
import { FakePhoneBrowserNative } from "./fake-native.test-support.js";
import type { PhoneTab } from "./state.js";

test("Android CDP stages session-owned files before routing page commands and fences closed attachments", async () => {
  const native = new FakePhoneBrowserNative("android");
  const epoch = native.fence("initialize");
  await native.attachAgent({
    epoch,
    channelId: "channel",
    sessionId: "session",
    attachmentId: "attachment",
    actorToken: "actor",
    backend: "cdp",
  });
  const stage = vi.spyOn(native, "stageChunk");
  vi.spyOn(native, "openCdpPipe").mockResolvedValue("pipe");
  const send = vi.spyOn(native, "sendCdp").mockResolvedValue({});
  const tab = {
    id: "tab",
    sessionId: "session",
    metadata: { generation: 1 },
    state: "live-covered",
  } as PhoneTab;
  const owner: PhoneCdpOwner = {
    sessionId: "session",
    epoch,
    attachmentId: "attachment",
    filesRoot: "/native/session",
    uuid: () => "request",
    tabs: () => [tab],
    ref: () => ({
      epoch,
      sessionId: "session",
      tabId: "tab",
      generation: 1,
      documentId: "document",
      geometryRevision: 1,
    }),
    resume: async () => {},
    create: async () => tab,
    close: async () => {},
    dialog: async () => {},
    execute: async (_tab, work) => work(),
    event: () => {},
  };
  const cdp = new PhoneCdpSession(native, owner);
  const parameters = {
    fileId: "11111111-1111-4111-8111-111111111111",
    name: "upload.txt",
    offset: 0,
    data: "dGVzdA==",
    size: 4,
  };
  stage.mockResolvedValueOnce({ fileId: parameters.fileId, complete: false });
  expect(await cdp.send({ method: "Opensteer.stageFile", parameters })).toEqual({});
  expect(await cdp.send({ method: "Opensteer.stageFile", parameters })).toEqual({
    path: `/native/session/${parameters.fileId}/upload.txt`,
  });
  expect(stage).toHaveBeenLastCalledWith({
    ...parameters,
    epoch,
    sessionId: "session",
    attachmentId: "attachment",
  });
  const attached = (await cdp.send({
    method: "Target.attachToTarget",
    parameters: { targetId: "tab", flatten: true },
  })) as { sessionId: string };
  const files = [`/native/session/${parameters.fileId}/upload.txt`];
  await expect(
    cdp.send({
      method: "DOM.setFileInputFiles",
      sessionId: attached.sessionId,
      parameters: { files, nodeId: 1 },
    }),
  ).resolves.toEqual({});
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ method: "DOM.setFileInputFiles", params: { files, nodeId: 1 } }),
  );
  for (const file of [
    "/native/other/upload.txt",
    "/native/session/../secret",
    "/native/session//upload.txt",
  ])
    await expect(
      cdp.send({
        method: "DOM.setFileInputFiles",
        sessionId: attached.sessionId,
        parameters: { files: [file], nodeId: 1 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    cdp.send({ method: "Opensteer.stageFile", parameters, sessionId: "page" }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    cdp.send({ method: "Opensteer.stageFile", parameters: { ...parameters, name: "../secret" } }),
  ).rejects.toThrow();
  tab.state = "retained";
  cdp.surfaceChanged(tab);
  await expect(
    cdp.send({
      method: "Runtime.evaluate",
      sessionId: attached.sessionId,
      parameters: { expression: "true" },
    }),
  ).rejects.toMatchObject({ code: "target-suspended" });
  await expect(
    cdp.capture(
      { method: "Page.captureScreenshot", sessionId: attached.sessionId },
      "channel",
      "capture",
    ),
  ).rejects.toMatchObject({ code: "target-suspended" });
  tab.state = "live-covered";
  tab.metadata = { ...tab.metadata, generation: tab.metadata.generation + 1 };
  cdp.surfaceChanged(tab);
  await expect(
    cdp.send({
      method: "Runtime.evaluate",
      sessionId: attached.sessionId,
      parameters: { expression: "true" },
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  tab.state = "closed";
  cdp.surfaceChanged(tab);
  await expect(
    cdp.send({
      method: "Runtime.evaluate",
      sessionId: attached.sessionId,
      parameters: { expression: "true" },
    }),
  ).rejects.toMatchObject({ code: "target-closed" });
  await cdp.close();
  await expect(cdp.send({ method: "Opensteer.stageFile", parameters })).rejects.toMatchObject({
    code: "target-closed",
  });
  expect(stage).toHaveBeenCalledTimes(2);
});
