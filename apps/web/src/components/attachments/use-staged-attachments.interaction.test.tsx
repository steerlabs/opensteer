// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClientRequestError, type HostClient } from "@opensteer/client/host";
import { Composer, type PendingSends } from "../composer.js";
import { composerDrafts } from "../composer-drafts.js";
import {
  discardAllStagedFiles,
  useStagedAttachments,
  type StagedAttachments,
} from "./use-staged-attachments.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const scope = "staged-files-test";
let root: Root | null = null;
let files: StagedAttachments;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  discardAllStagedFiles();
  localStorage.clear();
});

function Tray({ client }: { readonly client: HostClient }) {
  files = useStagedAttachments({ client, scope, workspaceId: "workspace" });
  return null;
}

/** Opens a draft holding one file the Host already has, as a reload does. */
async function reopen(getAttachment: HostClient["getAttachment"]) {
  const part = {
    artifactId: "file-1",
    mediaType: "text/plain",
    name: "notes.txt",
    type: "artifact",
  };
  composerDrafts.update(scope, {
    files: [{ mediaType: "text/plain", name: "notes.txt", part: part as never, sizeBytes: 3 }],
  });
  const client = { getAttachment } as unknown as HostClient;
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Tray client={client} />));
}

describe("a saved file checked against the Host", () => {
  it("offers another try when the Host could not be reached, then is ready", async () => {
    const getAttachment = vi
      .fn<HostClient["getAttachment"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({
        id: "file-1",
        mediaType: "text/plain",
        name: "notes.txt",
        sizeBytes: 3,
        state: "ready",
      } as never);
    await reopen(getAttachment);
    expect(files.items[0]).toMatchObject({ retryable: true, status: "failed" });

    await act(async () => files.retry(files.items[0]!.localId));

    expect(files.items[0]).toMatchObject({ error: null, status: "ready" });
  });

  it("asks for the file again when the Host no longer has it", async () => {
    await reopen(
      vi
        .fn<HostClient["getAttachment"]>()
        .mockRejectedValue(
          new HostClientRequestError({ code: "not_found", message: "Gone.", status: 404 }),
        ),
    );
    expect(files.items[0]).toMatchObject({ retryable: false, status: "failed" });
  });
});

describe("a message held for sending", () => {
  it("keeps its files to itself after a reload, out of the tray and the draft", async () => {
    const part = {
      artifactId: "file-1",
      mediaType: "text/plain",
      name: "notes.txt",
      type: "artifact",
    } as const;
    composerDrafts.update(scope, {
      files: [{ mediaType: part.mediaType, name: part.name, part, sizeBytes: 3 }],
    });
    const held: PendingSends = {
      claim: vi.fn(),
      clear: vi.fn(),
      discard: vi.fn(),
      read: () => ({ attachments: [part], body: "Sent", idempotencyKey: "message-1" }),
    };
    const client = { getAttachment: () => new Promise(() => {}) } as unknown as HostClient;
    const node = document.createElement("div");
    root = createRoot(node);
    await act(async () =>
      root?.render(
        <Composer
          attachments={{ client, scope, workspaceId: "workspace" }}
          draftKey={scope}
          onSend={async () => {}}
          pendingSends={held}
          placeholder="Reply…"
        />,
      ),
    );

    expect(composerDrafts.read(scope)).toBeNull();
    expect(node.querySelector(".attachment-tray")).toBeNull();
  });
});
