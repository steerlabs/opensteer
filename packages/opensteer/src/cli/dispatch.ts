import type { OpensteerSemanticOperationName } from "@opensteer/protocol";

import { OpensteerSessionRuntime } from "../sdk/runtime.js";

export type OpensteerSemanticRuntime = Pick<
  OpensteerSessionRuntime,
  | "open"
  | "goto"
  | "snapshot"
  | "click"
  | "hover"
  | "input"
  | "scroll"
  | "extract"
  | "queryNetwork"
  | "saveNetwork"
  | "clearNetwork"
  | "rawRequest"
  | "inferRequestPlan"
  | "writeRequestPlan"
  | "getRequestPlan"
  | "listRequestPlans"
  | "request"
  | "computerExecute"
  | "close"
>;

export async function dispatchSemanticOperation(
  runtime: OpensteerSemanticRuntime,
  operation: OpensteerSemanticOperationName,
  input: unknown,
  options: {
    readonly signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  switch (operation) {
    case "session.open":
      return runtime.open((input ?? {}) as Parameters<OpensteerSessionRuntime["open"]>[0], options);
    case "page.goto":
      return runtime.goto(input as Parameters<OpensteerSessionRuntime["goto"]>[0], options);
    case "page.snapshot":
      return runtime.snapshot(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["snapshot"]>[0],
        options,
      );
    case "dom.click":
      return runtime.click(input as Parameters<OpensteerSessionRuntime["click"]>[0], options);
    case "dom.hover":
      return runtime.hover(input as Parameters<OpensteerSessionRuntime["hover"]>[0], options);
    case "dom.input":
      return runtime.input(input as Parameters<OpensteerSessionRuntime["input"]>[0], options);
    case "dom.scroll":
      return runtime.scroll(input as Parameters<OpensteerSessionRuntime["scroll"]>[0], options);
    case "dom.extract":
      return runtime.extract(input as Parameters<OpensteerSessionRuntime["extract"]>[0], options);
    case "network.query":
      return runtime.queryNetwork(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["queryNetwork"]>[0],
        options,
      );
    case "network.save":
      return runtime.saveNetwork(input as Parameters<OpensteerSessionRuntime["saveNetwork"]>[0], options);
    case "network.clear":
      return runtime.clearNetwork(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["clearNetwork"]>[0],
        options,
      );
    case "request.raw":
      return runtime.rawRequest(input as Parameters<OpensteerSessionRuntime["rawRequest"]>[0], options);
    case "request-plan.infer":
      return runtime.inferRequestPlan(
        input as Parameters<OpensteerSessionRuntime["inferRequestPlan"]>[0],
        options,
      );
    case "request-plan.write":
      return runtime.writeRequestPlan(
        input as Parameters<OpensteerSessionRuntime["writeRequestPlan"]>[0],
        options,
      );
    case "request-plan.get":
      return runtime.getRequestPlan(input as Parameters<OpensteerSessionRuntime["getRequestPlan"]>[0], options);
    case "request-plan.list":
      return runtime.listRequestPlans(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["listRequestPlans"]>[0],
        options,
      );
    case "request.execute":
      return runtime.request(input as Parameters<OpensteerSessionRuntime["request"]>[0], options);
    case "computer.execute":
      return runtime.computerExecute(
        input as Parameters<OpensteerSessionRuntime["computerExecute"]>[0],
        options,
      );
    case "session.close":
      return runtime.close(options);
  }
}
