import type { OpensteerSemanticOperationName } from "@opensteer/protocol";

import type { OpensteerSemanticRuntime } from "../sdk/semantic-runtime.js";
import { OpensteerSessionRuntime } from "../sdk/runtime.js";

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
    case "page.list":
      return runtime.listPages(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["listPages"]>[0],
        options,
      );
    case "page.new":
      return runtime.newPage(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["newPage"]>[0],
        options,
      );
    case "page.activate":
      return runtime.activatePage(
        input as Parameters<OpensteerSessionRuntime["activatePage"]>[0],
        options,
      );
    case "page.close":
      return runtime.closePage(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["closePage"]>[0],
        options,
      );
    case "page.goto":
      return runtime.goto(input as Parameters<OpensteerSessionRuntime["goto"]>[0], options);
    case "page.evaluate":
      return runtime.evaluate(input as Parameters<OpensteerSessionRuntime["evaluate"]>[0], options);
    case "page.add-init-script":
      return runtime.addInitScript(
        input as Parameters<OpensteerSessionRuntime["addInitScript"]>[0],
        options,
      );
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
      return runtime.saveNetwork(
        input as Parameters<OpensteerSessionRuntime["saveNetwork"]>[0],
        options,
      );
    case "network.minimize":
      return runtime.minimizeNetwork(
        input as Parameters<OpensteerSessionRuntime["minimizeNetwork"]>[0],
        options,
      );
    case "network.diff":
      return runtime.diffNetwork(
        input as Parameters<OpensteerSessionRuntime["diffNetwork"]>[0],
        options,
      );
    case "network.probe":
      return runtime.probeNetwork(
        input as Parameters<OpensteerSessionRuntime["probeNetwork"]>[0],
        options,
      );
    case "reverse.solve":
      return runtime.solveReverse(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["solveReverse"]>[0],
        options,
      );
    case "reverse.replay":
      return runtime.replayReverse(
        input as Parameters<OpensteerSessionRuntime["replayReverse"]>[0],
        options,
      );
    case "reverse.export":
      return runtime.exportReverse(
        input as Parameters<OpensteerSessionRuntime["exportReverse"]>[0],
        options,
      );
    case "reverse.report":
      return runtime.getReverseReport(
        input as Parameters<OpensteerSessionRuntime["getReverseReport"]>[0],
        options,
      );
    case "reverse.package.get":
      return runtime.getReversePackage(
        input as Parameters<OpensteerSessionRuntime["getReversePackage"]>[0],
        options,
      );
    case "reverse.package.list":
      return runtime.listReversePackages(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["listReversePackages"]>[0],
        options,
      );
    case "reverse.package.patch":
      return runtime.patchReversePackage(
        input as Parameters<OpensteerSessionRuntime["patchReversePackage"]>[0],
        options,
      );
    case "interaction.capture":
      return runtime.captureInteraction(
        input as Parameters<OpensteerSessionRuntime["captureInteraction"]>[0],
        options,
      );
    case "interaction.get":
      return runtime.getInteraction(
        input as Parameters<OpensteerSessionRuntime["getInteraction"]>[0],
        options,
      );
    case "interaction.diff":
      return runtime.diffInteraction(
        input as Parameters<OpensteerSessionRuntime["diffInteraction"]>[0],
        options,
      );
    case "interaction.replay":
      return runtime.replayInteraction(
        input as Parameters<OpensteerSessionRuntime["replayInteraction"]>[0],
        options,
      );
    case "network.clear":
      return runtime.clearNetwork(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["clearNetwork"]>[0],
        options,
      );
    case "scripts.capture":
      return runtime.captureScripts(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["captureScripts"]>[0],
        options,
      );
    case "artifact.read":
      return runtime.readArtifact(
        input as Parameters<OpensteerSessionRuntime["readArtifact"]>[0],
        options,
      );
    case "scripts.beautify":
      return runtime.beautifyScript(
        input as Parameters<OpensteerSessionRuntime["beautifyScript"]>[0],
        options,
      );
    case "scripts.deobfuscate":
      return runtime.deobfuscateScript(
        input as Parameters<OpensteerSessionRuntime["deobfuscateScript"]>[0],
        options,
      );
    case "scripts.sandbox":
      return runtime.sandboxScript(
        input as Parameters<OpensteerSessionRuntime["sandboxScript"]>[0],
        options,
      );
    case "captcha.solve":
      return runtime.solveCaptcha(
        input as Parameters<OpensteerSessionRuntime["solveCaptcha"]>[0],
        options,
      );
    case "inspect.cookies":
      return runtime.getCookies(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["getCookies"]>[0],
        options,
      );
    case "inspect.storage":
      return runtime.getStorageSnapshot(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["getStorageSnapshot"]>[0],
        options,
      );
    case "request.raw":
      return runtime.rawRequest(
        input as Parameters<OpensteerSessionRuntime["rawRequest"]>[0],
        options,
      );
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
      return runtime.getRequestPlan(
        input as Parameters<OpensteerSessionRuntime["getRequestPlan"]>[0],
        options,
      );
    case "request-plan.list":
      return runtime.listRequestPlans(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["listRequestPlans"]>[0],
        options,
      );
    case "recipe.write":
      return runtime.writeRecipe(
        input as Parameters<OpensteerSessionRuntime["writeRecipe"]>[0],
        options,
      );
    case "recipe.get":
      return runtime.getRecipe(
        input as Parameters<OpensteerSessionRuntime["getRecipe"]>[0],
        options,
      );
    case "recipe.list":
      return runtime.listRecipes(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["listRecipes"]>[0],
        options,
      );
    case "recipe.run":
      return runtime.runRecipe(
        input as Parameters<OpensteerSessionRuntime["runRecipe"]>[0],
        options,
      );
    case "auth-recipe.write":
      return runtime.writeAuthRecipe(
        input as Parameters<OpensteerSessionRuntime["writeAuthRecipe"]>[0],
        options,
      );
    case "auth-recipe.get":
      return runtime.getAuthRecipe(
        input as Parameters<OpensteerSessionRuntime["getAuthRecipe"]>[0],
        options,
      );
    case "auth-recipe.list":
      return runtime.listAuthRecipes(
        (input ?? {}) as Parameters<OpensteerSessionRuntime["listAuthRecipes"]>[0],
        options,
      );
    case "auth-recipe.run":
      return runtime.runAuthRecipe(
        input as Parameters<OpensteerSessionRuntime["runAuthRecipe"]>[0],
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
