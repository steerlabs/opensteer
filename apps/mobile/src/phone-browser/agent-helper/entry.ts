import { createAgentHelper } from "./helper.js";

const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");
const helper = createAgentHelper(documentId);
Object.defineProperty(globalThis, "__opensteerAgentHelper", {
  configurable: false,
  writable: false,
  value: Object.freeze({
    version: 1,
    documentId,
    invoke: async (request: unknown) => {
      try {
        return { result: await helper.invoke(request) };
      } catch (error) {
        return {
          error: {
            code: error instanceof Error && "code" in error ? error.code : "outcome-unknown",
            message:
              error instanceof Error ? error.message.slice(0, 1_000) : "Helper operation failed",
          },
        };
      }
    },
  }),
});
addEventListener("pagehide", (event) => {
  if (!event.persisted) helper.dispose();
});
