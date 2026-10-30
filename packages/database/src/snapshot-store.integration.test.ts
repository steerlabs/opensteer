import { createId } from "@opensteer/core";
import { expect } from "vitest";
import { OpensteerStore } from "./store.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("Workspace snapshot history", (it) => {
  it("omits history without reading message rows or counts and retains metadata", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture, openLiveRequest } = storeFixture;
    const f = await startRunFixture("snapshot-omitted-history");
    const requestId = createId("request");
    await openLiveRequest(f, requestId);
    let messageQueries = 0;
    const observed = new OpensteerStore(
      database.withPlugin({
        transformQuery({ node }) {
          if (JSON.stringify(node).includes('"name":"messages"')) messageQueries += 1;
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      }),
    );
    const full = await observed.workspaceSnapshot(f.workspace.id);
    expect(full.messages.length).toBeGreaterThan(0);
    expect(full.messageWindows).toContainEqual(
      expect.objectContaining({ threadId: f.thread.id, totalItems: 1 }),
    );
    expect(full).not.toHaveProperty("messagesOmitted");
    expect(messageQueries).toBe(2);
    messageQueries = 0;
    const omitted = await observed.workspaceSnapshot(f.workspace.id, { omitMessages: true });
    expect.soft(omitted.messages).toEqual([]);
    expect.soft(omitted.messageWindows).toEqual([]);
    expect.soft(omitted).toHaveProperty("messagesOmitted", true);
    expect(messageQueries).toBe(0);
    expect(omitted.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(omitted), "utf8"));
    const metadata = ({
      messages: _messages,
      messageWindows: _windows,
      serializedBytes: _bytes,
      messagesOmitted: _omitted,
      ...rest
    }: typeof omitted) => rest;
    expect(metadata(omitted)).toEqual(metadata(full));
    // Viewer state still reads the latest published sequence, never history bodies.
    const withViewer = await store.workspaceSnapshot(f.workspace.id, { viewerId: f.userId });
    const omittedWithViewer = await store.workspaceSnapshot(f.workspace.id, {
      viewerId: f.userId,
      omitMessages: true,
    });
    expect(omittedWithViewer.readStates).toHaveLength(1);
    expect(metadata(omittedWithViewer)).toEqual(metadata(withViewer));
    expect(omittedWithViewer.pendingRequests).toContainEqual(
      expect.objectContaining({ id: requestId }),
    );
    expect(omittedWithViewer.runQueue).toContainEqual(expect.objectContaining({ id: f.run.id }));
  });
});
