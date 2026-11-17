// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  MockTeamHost,
  TeamSessionClient,
  createMemoryTeamPersistence,
} from "@opensteer/client/team";
import type { TeamMessage } from "@opensteer/protocol";
import { useTeamPreviews } from "./team-context.js";
vi.mock("@react-navigation/native", () => ({ useFocusEffect: () => {} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("delivers an in-flight image preview after new messages arrive", async () => {
  const host = new MockTeamHost();
  const read = Promise.withResolvers<Blob>();
  const session = new TeamSessionClient({
    scope: { teamDeploymentId: host.teamId, userId: host.userId },
    rpc: host.rpc,
    connect: host.connect,
    persistence: createMemoryTeamPersistence(),
    readFile: () => read.promise,
  });
  const message = {
    attachments: [{ id: createId("teamBlob"), preview: { mediaType: "image/png", sizeBytes: 1 } }],
  } as TeamMessage;
  function Preview({ messages }: { messages: readonly TeamMessage[] }) {
    const previews = useTeamPreviews(session, messages);
    return <span>{previews.get(message.attachments[0]!.id)}</span>;
  }
  const node = document.createElement("div"),
    root = createRoot(node);
  try {
    act(() => root.render(<Preview messages={[message]} />));
    act(() =>
      root.render(<Preview messages={[message, { attachments: [] } as unknown as TeamMessage]} />),
    );
    await act(async () => read.resolve(new Blob(["image"], { type: "image/png" })));
    await vi.waitFor(() => expect(node.textContent).toContain("data:image/png;base64,"), {
      timeout: 1000,
    });
  } finally {
    read.resolve(new Blob());
    act(() => root.unmount());
    session.dispose();
    host.dispose();
  }
});
