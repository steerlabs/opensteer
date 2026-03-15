import type { OpensteerSemanticOperationName } from "@opensteer/protocol";

import { OpensteerSessionRuntime } from "../sdk/runtime.js";

export async function dispatchSemanticOperation(
  runtime: OpensteerSessionRuntime,
  operation: OpensteerSemanticOperationName,
  input: unknown,
): Promise<unknown> {
  switch (operation) {
    case "session.open":
      return runtime.open((input ?? {}) as Parameters<OpensteerSessionRuntime["open"]>[0]);
    case "page.goto":
      return runtime.goto(input as Parameters<OpensteerSessionRuntime["goto"]>[0]);
    case "page.snapshot":
      return runtime.snapshot((input ?? {}) as Parameters<OpensteerSessionRuntime["snapshot"]>[0]);
    case "dom.click":
      return runtime.click(input as Parameters<OpensteerSessionRuntime["click"]>[0]);
    case "dom.hover":
      return runtime.hover(input as Parameters<OpensteerSessionRuntime["hover"]>[0]);
    case "dom.input":
      return runtime.input(input as Parameters<OpensteerSessionRuntime["input"]>[0]);
    case "dom.scroll":
      return runtime.scroll(input as Parameters<OpensteerSessionRuntime["scroll"]>[0]);
    case "dom.extract":
      return runtime.extract(input as Parameters<OpensteerSessionRuntime["extract"]>[0]);
    case "request-capture.start":
      return runtime.startRequestCapture(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["startRequestCapture"]>[0],
      );
    case "request-capture.stop":
      return runtime.stopRequestCapture();
    case "request-plan.write":
      return runtime.writeRequestPlan(input as Parameters<OpensteerSessionRuntime["writeRequestPlan"]>[0]);
    case "request-plan.get":
      return runtime.getRequestPlan(input as Parameters<OpensteerSessionRuntime["getRequestPlan"]>[0]);
    case "request-plan.list":
      return runtime.listRequestPlans(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["listRequestPlans"]>[0],
      );
    case "request.execute":
      return runtime.request(input as Parameters<OpensteerSessionRuntime["request"]>[0]);
    case "computer.execute":
      return runtime.computerExecute(input as Parameters<OpensteerSessionRuntime["computerExecute"]>[0]);
    case "session.close":
      return runtime.close();
  }
}
