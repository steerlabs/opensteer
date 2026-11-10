import { BrowserSurfaceIdSchema, type BrowserServerMessage } from "@opensteer/protocol";
import { browserBasicInputAllows } from "@opensteer/protocol/browser";
import { decodeBase64Url, encodeBase64Url } from "@opensteer/shared/base64url";
import { splitGraphemes } from "unicode-segmenter/grapheme";
import { editingClipboardPartMaxBytes } from "@opensteer/protocol/editing";
import { BrowserEditingStore } from "../host/browser-editing.js";
import type { BrowserCommand } from "../host/client.js";

interface Field {
  readonly contextId: string;
  text: string;
  start: number;
  end: number;
}

export class MockBrowserInput {
  readonly editing: BrowserEditingStore;
  readonly #fields = new Map<string, Field>();
  readonly #pastes = new Map<
    string,
    { sessionId: string; surfaceId: string; size: number; bytes: Uint8Array[] }
  >();
  constructor(send: (sessionId: string, command: BrowserCommand) => void) {
    this.editing = new BrowserEditingStore((sessionId, _surfaceId, command) =>
      send(sessionId, command),
    );
  }
  #field(sessionId: string, surfaceId: string): Field {
    const key = JSON.stringify([sessionId, surfaceId]);
    let field = this.#fields.get(key);
    if (!field) {
      field = { contextId: crypto.randomUUID(), text: "", start: 0, end: 0 };
      this.#fields.set(key, field);
    }
    return field;
  }
  retain(sessionId: string, surfaceId: string): void {
    this.editing.negotiate(sessionId, undefined, surfaceId, false, 1);
    this.editing.receive(sessionId, {
      type: "browser.editing",
      surfaceId: BrowserSurfaceIdSchema.parse(surfaceId),
      context: {
        contextId: this.#field(sessionId, surfaceId).contextId,
        field: { kind: "text", multiline: true, sensitive: false },
        caret: null,
      },
    });
  }
  command(sessionId: string, command: BrowserCommand): void {
    const receive = (message: BrowserServerMessage) => this.editing.receive(sessionId, message);
    if (!browserBasicInputAllows(command)) {
      receive({
        type: "browser.error",
        error: {
          code: "conflict",
          reason: "unsupported-operation",
          message: "This operation is unavailable.",
          retryable: false,
        },
      });
      return;
    }
    if (command.type === "clipboard.part") {
      const paste = this.#pastes.get(command.part.operationId);
      if (!paste || paste.sessionId !== sessionId || command.part.index !== paste.bytes.length)
        return;
      paste.bytes.push(
        decodeBase64Url(
          command.part.data.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
        ),
      );
      const size = paste.bytes.reduce((total, bytes) => total + bytes.length, 0);
      if (size !== paste.size) return;
      this.#pastes.delete(command.part.operationId);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of paste.bytes) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      this.#insert(this.#field(sessionId, paste.surfaceId), new TextDecoder().decode(bytes));
      receive({
        type: "clipboard.result",
        surfaceId: BrowserSurfaceIdSchema.parse(paste.surfaceId),
        operationId: command.part.operationId,
        outcome: "pasted",
      });
      return;
    }
    if (!("surfaceId" in command) || !command.surfaceId) return;
    const surfaceId = BrowserSurfaceIdSchema.parse(command.surfaceId);
    const field = this.#field(sessionId, surfaceId);
    if (command.type === "input.text") this.#insert(field, command.edit.text);
    else if (command.type === "input.compose") {
      const start = field.start;
      this.#insert(field, command.composition.text);
      field.start = start;
    } else if (command.type === "input.command" && command.command === "selectAll") {
      field.start = 0;
      field.end = field.text.length;
    } else if (
      (command.type === "input.command" && command.command === "deleteBackward") ||
      (command.type === "input.key" && command.action === "down" && command.key === "Backspace")
    ) {
      if (field.start === field.end) {
        const characters = [...splitGraphemes(field.text.slice(0, field.start))];
        field.start -= characters.at(-1)?.length ?? 0;
      }
      this.#insert(field, "");
    } else if (command.type === "input.key" && command.action === "down") {
      this.#insert(field, command.key === "Enter" ? "\n" : (command.text ?? ""));
    } else if (command.type === "clipboard.copy") {
      const bytes = new TextEncoder().encode(field.text.slice(field.start, field.end));
      receive({
        type: "clipboard.result",
        surfaceId,
        operationId: command.operationId,
        outcome: bytes.length ? "copied" : "empty",
        items: [{ type: "text/plain", size: bytes.length }],
      });
      if (bytes.length) {
        for (
          let offset = 0, index = 0;
          offset < bytes.length;
          offset += editingClipboardPartMaxBytes, index++
        ) {
          const data = encodeBase64Url(
            bytes.subarray(offset, offset + editingClipboardPartMaxBytes),
          )
            .replaceAll("-", "+")
            .replaceAll("_", "/");
          receive({
            type: "clipboard.part",
            part: {
              operationId: command.operationId,
              index,
              data: data + "=".repeat((4 - (data.length % 4)) % 4),
            },
          });
        }
      }
    } else if (command.type === "clipboard.paste-data") {
      this.#pastes.set(command.operationId, {
        sessionId,
        surfaceId,
        size: command.items[0]!.size,
        bytes: [],
      });
    } else if (command.type === "clipboard.paste") this.#insert(field, command.text);
  }
  #insert(field: Field, text: string): void {
    field.text = field.text.slice(0, field.start) + text + field.text.slice(field.end);
    field.start += text.length;
    field.end = field.start;
  }
  dispose(): void {
    this.editing.dispose();
    this.#fields.clear();
    this.#pastes.clear();
  }
}
