import { OpensteerError } from "@opensteer/core";
import type { TabActor, TabServicePort } from "../../tabs/ports.js";
import type { AgentCaller } from "../agent-caller.js";
import { operationId, requireRun } from "../operations.js";
import type { ToolCall } from "./types.js";

function actor(caller: AgentCaller): TabActor {
  if (caller.kind === "run") return { kind: "run", claims: caller.claims };
  if (caller.kind === "connection") return { kind: "connection", caller };
  throw new OpensteerError({ code: "forbidden", message: "Programs cannot access tabs." });
}
export class TabToolHandlers {
  readonly #tabs: TabServicePort;
  constructor(tabs: TabServicePort) {
    this.#tabs = tabs;
  }
  async tab_list({ caller, input }: ToolCall<"tab_list">) {
    return this.#tabs.list(actor(caller), input);
  }
  async tab_open({ caller, input, operationKey }: ToolCall<"tab_open">) {
    requireRun(caller);
    return this.#tabs.open(
      actor(caller),
      input.target,
      operationId(caller, operationKey, "tab_open"),
    );
  }
  async tab_close({ caller, input, operationKey }: ToolCall<"tab_close">) {
    requireRun(caller);
    return this.#tabs.close(
      actor(caller),
      input.tabIds,
      operationId(caller, operationKey, "tab_close"),
    );
  }
  async tab_organize({ caller, input, operationKey }: ToolCall<"tab_organize">) {
    requireRun(caller);
    return this.#tabs.organize(
      actor(caller),
      input,
      operationId(caller, operationKey, "tab_organize"),
    );
  }
  async tab_group_update({ caller, input, operationKey }: ToolCall<"tab_group_update">) {
    requireRun(caller);
    return this.#tabs.updateGroup(
      actor(caller),
      input,
      operationId(caller, operationKey, "tab_group_update"),
    );
  }
}
