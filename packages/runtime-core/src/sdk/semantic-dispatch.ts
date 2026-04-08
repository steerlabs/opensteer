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
    case "network.detail":
      return runtime.getNetworkDetail(
        input as Parameters<OpensteerSemanticRuntime["getNetworkDetail"]>[0],
        options,
      );
    case "network.replay":
      return runtime.replayNetwork(
        input as Parameters<OpensteerSemanticRuntime["replayNetwork"]>[0],
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
    case "session.cookies":
      return runtime.getCookies(
        input as Parameters<OpensteerSemanticRuntime["getCookies"]>[0],
        options,
      );
    case "session.storage":
      return runtime.getStorageSnapshot(
        input as Parameters<OpensteerSemanticRuntime["getStorageSnapshot"]>[0],
        options,
      );
    case "session.state":
      return runtime.getBrowserState(
        input as Parameters<OpensteerSemanticRuntime["getBrowserState"]>[0],
        options,
      );
    case "session.fetch":
      return runtime.fetch(input as Parameters<OpensteerSemanticRuntime["fetch"]>[0], options);
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
    case "computer.execute":
      return runtime.computerExecute(
        input as Parameters<OpensteerSemanticRuntime["computerExecute"]>[0],
        options,
      );
    case "session.close":
      return runtime.close(options);
  }
}
