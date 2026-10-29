import { getIntegrationDefinition } from "@opensteer/integration-catalog";
import { parseComputerAppConfig } from "@opensteer/integration-core/computer-app";
import {
  computerUseDataApps,
  type ComputerUseDataAppId,
  type ComputerUseDataGrant,
  type ComputerUseDataInvokeParams,
} from "@opensteer/protocol";
import { ComputerUseBridgeError } from "./computer-use-bridge-client.js";
import type { ComputerUseHandler } from "./computer-use-handler.js";
import {
  ComputerAppError,
  type ComputerAppOperationInspection,
  type ComputerAppProvider,
  type ComputerAppProviderErrorCode,
} from "./provider.js";

/** What an app the helper serves needs of this Mac's computer-use bridge. */
export type HelperDataPort = Pick<ComputerUseHandler, "dataGrants" | "dataInvoke">;

/**
 * The sentence for each grant a person has to allow. Like every provider
 * sentence it describes the app and nothing else: the Host names the computer.
 * Each names the app macOS lists, because the person has two Opensteer apps in
 * those lists and only the helper is the answer; it matches the helper's own.
 */
const grantSentences: Readonly<Record<ComputerUseDataGrant, string>> = {
  automation: "Sending in Messages needs macOS Automation permission for Opensteer Computer Use.",
  calendars: "Calendar needs macOS full access to calendars for Opensteer Computer Use.",
  contacts: "Reading Contacts needs macOS access to Contacts for Opensteer Computer Use.",
  "full-disk-access": "Reading Messages needs macOS Full Disk Access for Opensteer Computer Use.",
  reminders: "Reminders needs macOS full access to reminders for Opensteer Computer Use.",
};

/**
 * One app served by the signed helper rather than by this Runner.
 *
 * The helper holds the macOS grants — Contacts, Calendars, Reminders, its own
 * Full Disk Access and Automation for Messages — so that no process an agent
 * can start holds them, and this Runner only carries calls to it: each
 * operation's readiness from the grant its effect needs, each call with the
 * access and contract the Host resolved, which the helper checks again itself.
 * A grant macOS cannot report yet reads as ready, because the helper settles
 * it, without asking, before it acts. On a Mac without the desktop app there
 * is no helper to carry calls to, and the app says so rather than reading
 * anything another way.
 */
export function createHelperAppProvider(
  definitionId: ComputerUseDataAppId,
  helper: HelperDataPort | null,
): ComputerAppProvider {
  const definition = getIntegrationDefinition(definitionId);
  if (!definition) throw new Error(`The catalog has no ${definitionId}`);
  const operations = parseComputerAppConfig(definition).operations;
  const grants = computerUseDataApps[definitionId];
  const desktopMissing = `${definition.name} needs the Opensteer desktop app.`;
  const every = (
    inspection: Omit<ComputerAppOperationInspection, "operation">,
  ): readonly ComputerAppOperationInspection[] =>
    operations.map(({ name }) => ({ operation: name, ...inspection }));

  return {
    definitionId,
    platforms: ["darwin"],

    async inspect() {
      if (!helper) return every({ detail: desktopMissing, remedy: null, state: "unavailable" });
      let states;
      try {
        states = await helper.dataGrants();
      } catch (error) {
        return every({
          detail:
            error instanceof ComputerUseBridgeError
              ? error.message
              : `${definition.name} could not be checked.`,
          remedy: null,
          state: "unavailable",
        });
      }
      return operations.map(({ effect, name }) => {
        const grant = grants[effect];
        return states[grant] === "granted" || states[grant] === "unknown"
          ? {
              detail: effect === "read" ? "Ready to read" : "Ready",
              operation: name,
              remedy: null,
              state: "ready" as const,
            }
          : {
              detail: grantSentences[grant],
              operation: name,
              remedy: grant,
              state: "permission-required" as const,
            };
      });
    },

    async invoke(operation, args, signal, invocation) {
      if (!helper) throw new ComputerAppError("failed", desktopMissing);
      try {
        return await helper.dataInvoke(
          {
            access: invocation.access,
            // The Host validated these against the operation's schema, and the
            // frame they arrived in carries JSON only.
            arguments: args as ComputerUseDataInvokeParams["arguments"],
            contract: invocation.contract,
            definitionId,
            effect: invocation.effect,
            operation,
          },
          { deadline: invocation.deadline, signal },
        );
      } catch (error) {
        if (!(error instanceof ComputerUseBridgeError)) throw error;
        if (error.code === "permission-required") {
          throw new ComputerAppError(
            "permission-required",
            grantSentences[grants[invocation.effect]],
          );
        }
        throw new ComputerAppError(computerAppCode(error.code), error.message);
      }
    },
  };
}

/** The helper's vocabulary is computer use's; an app speaks a narrower one. */
function computerAppCode(code: ComputerUseBridgeError["code"]): ComputerAppProviderErrorCode {
  switch (code) {
    case "outcome-unknown":
    case "unsupported":
    case "permission-required":
      return code;
    default:
      return "failed";
  }
}
