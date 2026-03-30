import type { OpensteerSemanticOperationName } from "@opensteer/protocol";

import type { OpensteerSemanticRuntime } from "./semantic-runtime.js";

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
      return runtime.open(input as Parameters<OpensteerSemanticRuntime["open"]>[0], options);
    case "page.list":
      return runtime.listPages(
        input as Parameters<OpensteerSemanticRuntime["listPages"]>[0],
        options,
      );
    case "page.new":
      return runtime.newPage(input as Parameters<OpensteerSemanticRuntime["newPage"]>[0], options);
    case "page.activate":
      return runtime.activatePage(
        input as Parameters<OpensteerSemanticRuntime["activatePage"]>[0],
        options,
      );
    case "page.close":
      return runtime.closePage(
        input as Parameters<OpensteerSemanticRuntime["closePage"]>[0],
        options,
      );
    case "page.goto":
      return runtime.goto(input as Parameters<OpensteerSemanticRuntime["goto"]>[0], options);
    case "page.evaluate":
      return runtime.evaluate(
        input as Parameters<OpensteerSemanticRuntime["evaluate"]>[0],
        options,
      );
    case "page.add-init-script":
      return runtime.addInitScript(
        input as Parameters<OpensteerSemanticRuntime["addInitScript"]>[0],
        options,
      );
    case "page.snapshot":
      return runtime.snapshot(
        input as Parameters<OpensteerSemanticRuntime["snapshot"]>[0],
        options,
      );
    case "dom.click":
      return runtime.click(input as Parameters<OpensteerSemanticRuntime["click"]>[0], options);
    case "dom.hover":
      return runtime.hover(input as Parameters<OpensteerSemanticRuntime["hover"]>[0], options);
    case "dom.input":
      return runtime.input(input as Parameters<OpensteerSemanticRuntime["input"]>[0], options);
    case "dom.scroll":
      return runtime.scroll(input as Parameters<OpensteerSemanticRuntime["scroll"]>[0], options);
    case "dom.extract":
      return runtime.extract(input as Parameters<OpensteerSemanticRuntime["extract"]>[0], options);
    case "network.query":
      return runtime.queryNetwork(
        input as Parameters<OpensteerSemanticRuntime["queryNetwork"]>[0],
        options,
      );
    case "network.save":
      return runtime.saveNetwork(
        input as Parameters<OpensteerSemanticRuntime["saveNetwork"]>[0],
        options,
      );
    case "network.clear":
      return runtime.clearNetwork(
        input as Parameters<OpensteerSemanticRuntime["clearNetwork"]>[0],
        options,
      );
    case "network.minimize":
      return runtime.minimizeNetwork(
        input as Parameters<OpensteerSemanticRuntime["minimizeNetwork"]>[0],
        options,
      );
    case "network.diff":
      return runtime.diffNetwork(
        input as Parameters<OpensteerSemanticRuntime["diffNetwork"]>[0],
        options,
      );
    case "network.probe":
      return runtime.probeNetwork(
        input as Parameters<OpensteerSemanticRuntime["probeNetwork"]>[0],
        options,
      );
    case "reverse.discover":
      return runtime.discoverReverse(
        input as Parameters<OpensteerSemanticRuntime["discoverReverse"]>[0],
        options,
      );
    case "reverse.query":
      return runtime.queryReverse(
        input as Parameters<OpensteerSemanticRuntime["queryReverse"]>[0],
        options,
      );
    case "reverse.package.create":
      return runtime.createReversePackage(
        input as Parameters<OpensteerSemanticRuntime["createReversePackage"]>[0],
        options,
      );
    case "reverse.package.run":
      return runtime.runReversePackage(
        input as Parameters<OpensteerSemanticRuntime["runReversePackage"]>[0],
        options,
      );
    case "reverse.export":
      return runtime.exportReverse(
        input as Parameters<OpensteerSemanticRuntime["exportReverse"]>[0],
        options,
      );
    case "reverse.report":
      return runtime.getReverseReport(
        input as Parameters<OpensteerSemanticRuntime["getReverseReport"]>[0],
        options,
      );
    case "reverse.package.get":
      return runtime.getReversePackage(
        input as Parameters<OpensteerSemanticRuntime["getReversePackage"]>[0],
        options,
      );
    case "reverse.package.list":
      return runtime.listReversePackages(
        input as Parameters<OpensteerSemanticRuntime["listReversePackages"]>[0],
        options,
      );
    case "reverse.package.patch":
      return runtime.patchReversePackage(
        input as Parameters<OpensteerSemanticRuntime["patchReversePackage"]>[0],
        options,
      );
    case "interaction.capture":
      return runtime.captureInteraction(
        input as Parameters<OpensteerSemanticRuntime["captureInteraction"]>[0],
        options,
      );
    case "interaction.get":
      return runtime.getInteraction(
        input as Parameters<OpensteerSemanticRuntime["getInteraction"]>[0],
        options,
      );
    case "interaction.diff":
      return runtime.diffInteraction(
        input as Parameters<OpensteerSemanticRuntime["diffInteraction"]>[0],
        options,
      );
    case "interaction.replay":
      return runtime.replayInteraction(
        input as Parameters<OpensteerSemanticRuntime["replayInteraction"]>[0],
        options,
      );
    case "artifact.read":
      return runtime.readArtifact(
        input as Parameters<OpensteerSemanticRuntime["readArtifact"]>[0],
        options,
      );
    case "inspect.cookies":
      return runtime.getCookies(
        input as Parameters<OpensteerSemanticRuntime["getCookies"]>[0],
        options,
      );
    case "inspect.storage":
      return runtime.getStorageSnapshot(
        input as Parameters<OpensteerSemanticRuntime["getStorageSnapshot"]>[0],
        options,
      );
    case "scripts.capture":
      return runtime.captureScripts(
        input as Parameters<OpensteerSemanticRuntime["captureScripts"]>[0],
        options,
      );
    case "scripts.beautify":
      return runtime.beautifyScript(
        input as Parameters<OpensteerSemanticRuntime["beautifyScript"]>[0],
        options,
      );
    case "scripts.deobfuscate":
      return runtime.deobfuscateScript(
        input as Parameters<OpensteerSemanticRuntime["deobfuscateScript"]>[0],
        options,
      );
    case "scripts.sandbox":
      return runtime.sandboxScript(
        input as Parameters<OpensteerSemanticRuntime["sandboxScript"]>[0],
        options,
      );
    case "captcha.solve":
      return runtime.solveCaptcha(
        input as Parameters<OpensteerSemanticRuntime["solveCaptcha"]>[0],
        options,
      );
    case "request.raw":
      return runtime.rawRequest(
        input as Parameters<OpensteerSemanticRuntime["rawRequest"]>[0],
        options,
      );
    case "request-plan.infer":
      return runtime.inferRequestPlan(
        input as Parameters<OpensteerSemanticRuntime["inferRequestPlan"]>[0],
        options,
      );
    case "request-plan.write":
      return runtime.writeRequestPlan(
        input as Parameters<OpensteerSemanticRuntime["writeRequestPlan"]>[0],
        options,
      );
    case "request-plan.get":
      return runtime.getRequestPlan(
        input as Parameters<OpensteerSemanticRuntime["getRequestPlan"]>[0],
        options,
      );
    case "request-plan.list":
      return runtime.listRequestPlans(
        input as Parameters<OpensteerSemanticRuntime["listRequestPlans"]>[0],
        options,
      );
    case "recipe.write":
      return runtime.writeRecipe(
        input as Parameters<OpensteerSemanticRuntime["writeRecipe"]>[0],
        options,
      );
    case "recipe.get":
      return runtime.getRecipe(
        input as Parameters<OpensteerSemanticRuntime["getRecipe"]>[0],
        options,
      );
    case "recipe.list":
      return runtime.listRecipes(
        input as Parameters<OpensteerSemanticRuntime["listRecipes"]>[0],
        options,
      );
    case "recipe.run":
      return runtime.runRecipe(
        input as Parameters<OpensteerSemanticRuntime["runRecipe"]>[0],
        options,
      );
    case "auth-recipe.write":
      return runtime.writeAuthRecipe(
        input as Parameters<OpensteerSemanticRuntime["writeAuthRecipe"]>[0],
        options,
      );
    case "auth-recipe.get":
      return runtime.getAuthRecipe(
        input as Parameters<OpensteerSemanticRuntime["getAuthRecipe"]>[0],
        options,
      );
    case "auth-recipe.list":
      return runtime.listAuthRecipes(
        input as Parameters<OpensteerSemanticRuntime["listAuthRecipes"]>[0],
        options,
      );
    case "auth-recipe.run":
      return runtime.runAuthRecipe(
        input as Parameters<OpensteerSemanticRuntime["runAuthRecipe"]>[0],
        options,
      );
    case "request.execute":
      return runtime.request(input as Parameters<OpensteerSemanticRuntime["request"]>[0], options);
    case "computer.execute":
      return runtime.computerExecute(
        input as Parameters<OpensteerSemanticRuntime["computerExecute"]>[0],
        options,
      );
    case "session.close":
      return runtime.close(options);
  }
}
