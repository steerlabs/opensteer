import { describe, expect, it, vi } from "vitest";
import type { ComputerUseDataGrants, ComputerUseDataInvokeParams } from "@opensteer/protocol";
import { ComputerUseBridgeError } from "./computer-use-bridge-client.js";
import { createHelperAppProvider, type HelperDataPort } from "./helper-app-provider.js";
import { ComputerAppError } from "./provider.js";

/**
 * Every way an app the helper serves can answer this Runner, written before
 * the provider: readiness comes from the helper's grants, a call carries the
 * Host's access and contract to the one process holding the grant, and the
 * helper's refusals arrive in the words agents already read for any app.
 */
const invocation = {
  access: "read",
  contract: "3jIkyOGdGD_IZnx58GNe_TRdSPv6jU_fcUxq1OYpl7k",
  deadline: 1_700_000_030_000,
  effect: "read",
} as const;

function port(grants: Partial<ComputerUseDataGrants> = {}): HelperDataPort & {
  readonly invoked: ComputerUseDataInvokeParams[];
} {
  const invoked: ComputerUseDataInvokeParams[] = [];
  return {
    dataGrants: vi.fn(async (): Promise<ComputerUseDataGrants> => ({
      automation: "granted",
      calendars: "granted",
      contacts: "granted",
      "full-disk-access": "granted",
      reminders: "granted",
      ...grants,
    })),
    dataInvoke: vi.fn(async (params: ComputerUseDataInvokeParams) => {
      invoked.push(params);
      return { contacts: [], nextCursor: null };
    }),
    invoked,
  };
}

describe("an app the helper serves", () => {
  it("is unavailable, saying why, on a Mac without the desktop app", async () => {
    const provider = createHelperAppProvider("apple-contacts", null);
    // The Host names the computer: "Contacts needs the Opensteer desktop app on Alex's Mac."
    const sentence = "Contacts needs the Opensteer desktop app.";
    expect(await provider.inspect()).toEqual([
      { detail: sentence, operation: "search_contacts", remedy: null, state: "unavailable" },
    ]);
    // Not `unsupported`, which the Host reads as "update Opensteer".
    await expect(
      provider.invoke("search_contacts", {}, new AbortController().signal, invocation),
    ).rejects.toEqual(new ComputerAppError("failed", sentence));
  });

  it("is ready once the person allowed its grant", async () => {
    const provider = createHelperAppProvider("apple-contacts", port());
    expect(await provider.inspect()).toEqual([
      { detail: "Ready to read", operation: "search_contacts", remedy: null, state: "ready" },
    ]);
  });

  it("names the grant a person has to allow, whether macOS will ask or only Settings can", async () => {
    for (const contacts of ["requestable", "denied"] as const) {
      const provider = createHelperAppProvider("apple-contacts", port({ contacts }));
      expect(await provider.inspect()).toEqual([
        {
          detail: "Reading Contacts needs macOS access to Contacts for Opensteer Computer Use.",
          operation: "search_contacts",
          remedy: "contacts",
          state: "permission-required",
        },
      ]);
    }
  });

  it("holds each operation to the grant its effect needs, as Messages' reads and sends are", async () => {
    const provider = createHelperAppProvider(
      "apple-messages",
      port({ automation: "requestable", "full-disk-access": "granted" }),
    );
    expect(await provider.inspect()).toEqual([
      { detail: "Ready to read", operation: "list_conversations", remedy: null, state: "ready" },
      { detail: "Ready to read", operation: "read_messages", remedy: null, state: "ready" },
      {
        detail: "Sending in Messages needs macOS Automation permission for Opensteer Computer Use.",
        operation: "send_message",
        remedy: "automation",
        state: "permission-required",
      },
    ]);
    const unread = createHelperAppProvider(
      "apple-messages",
      port({ "full-disk-access": "denied" }),
    );
    expect((await unread.inspect())[0]).toEqual({
      detail: "Reading Messages needs macOS Full Disk Access for Opensteer Computer Use.",
      operation: "list_conversations",
      remedy: "full-disk-access",
      state: "permission-required",
    });
  });

  it("reads a grant macOS cannot report yet as ready, since the helper settles it before acting", async () => {
    // Automation is reported only while Messages runs; a send checks it first.
    const provider = createHelperAppProvider("apple-messages", port({ automation: "unknown" }));
    expect((await provider.inspect())[2]).toEqual({
      detail: "Ready",
      operation: "send_message",
      remedy: null,
      state: "ready",
    });
  });

  it("is unavailable with the desktop's own words when the desktop cannot answer", async () => {
    const unreachable = port();
    vi.mocked(unreachable.dataGrants).mockRejectedValue(
      new ComputerUseBridgeError("failed", "The Opensteer desktop app is not running on this Mac."),
    );
    const provider = createHelperAppProvider("apple-contacts", unreachable);
    expect(await provider.inspect()).toEqual([
      {
        detail: "The Opensteer desktop app is not running on this Mac.",
        operation: "search_contacts",
        remedy: null,
        state: "unavailable",
      },
    ]);
  });

  it("carries the Host's access, contract and effect to the helper with the arguments", async () => {
    const helper = port();
    const provider = createHelperAppProvider("apple-contacts", helper);
    const signal = new AbortController().signal;
    await expect(
      provider.invoke("search_contacts", { query: "Ada" }, signal, invocation),
    ).resolves.toEqual({ contacts: [], nextCursor: null });
    expect(helper.invoked).toEqual([
      {
        access: "read",
        arguments: { query: "Ada" },
        contract: invocation.contract,
        definitionId: "apple-contacts",
        effect: "read",
        operation: "search_contacts",
      },
    ]);
    expect(helper.dataInvoke).toHaveBeenCalledWith(expect.anything(), {
      deadline: invocation.deadline,
      signal,
    });
  });

  it("answers the helper's refusals in computer-app terms, never losing a possible change", async () => {
    const cases = [
      [
        new ComputerUseBridgeError("permission-required", "anything the helper said"),
        new ComputerAppError(
          "permission-required",
          "Reading Contacts needs macOS access to Contacts for Opensteer Computer Use.",
        ),
      ],
      [
        new ComputerUseBridgeError("outcome-unknown", "The change may already have been made."),
        new ComputerAppError("outcome-unknown", "The change may already have been made."),
      ],
      [
        new ComputerUseBridgeError("unsupported", "This operation is not supported."),
        new ComputerAppError("unsupported", "This operation is not supported."),
      ],
      [
        new ComputerUseBridgeError("failed", "That cursor was not issued by this search."),
        new ComputerAppError("failed", "That cursor was not issued by this search."),
      ],
      [
        new ComputerUseBridgeError("busy", "This app is already being used by another task."),
        new ComputerAppError("failed", "This app is already being used by another task."),
      ],
    ] as const;
    for (const [said, answered] of cases) {
      const helper = port();
      vi.mocked(helper.dataInvoke).mockRejectedValue(said);
      const provider = createHelperAppProvider("apple-contacts", helper);
      await expect(
        provider.invoke("search_contacts", {}, new AbortController().signal, invocation),
      ).rejects.toEqual(answered);
    }
  });
});
