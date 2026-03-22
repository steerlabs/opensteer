import type {
  OpensteerArtifactReadInput,
  OpensteerArtifactReadOutput,
  CookieRecord,
  OpensteerAddInitScriptInput,
  OpensteerAddInitScriptOutput,
  OpensteerActionResult,
  OpensteerCaptchaSolveInput,
  OpensteerCaptchaSolveOutput,
  OpensteerCaptureScriptsInput,
  OpensteerCaptureScriptsOutput,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerDomClickInput,
  OpensteerDomExtractInput,
  OpensteerDomExtractOutput,
  OpensteerDomHoverInput,
  OpensteerDomInputInput,
  OpensteerDomScrollInput,
  OpensteerGetRecipeInput,
  OpensteerGetAuthRecipeInput,
  OpensteerGetRequestPlanInput,
  OpensteerInferRequestPlanInput,
  OpensteerListRecipesInput,
  OpensteerListRecipesOutput,
  OpensteerListAuthRecipesInput,
  OpensteerListAuthRecipesOutput,
  OpensteerListRequestPlansInput,
  OpensteerListRequestPlansOutput,
  OpensteerNetworkClearInput,
  OpensteerNetworkClearOutput,
  OpensteerNetworkDiffInput,
  OpensteerNetworkDiffOutput,
  OpensteerNetworkMinimizeInput,
  OpensteerNetworkMinimizeOutput,
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkSaveInput,
  OpensteerNetworkSaveOutput,
  OpensteerInteractionCaptureInput,
  OpensteerInteractionCaptureOutput,
  OpensteerInteractionDiffInput,
  OpensteerInteractionDiffOutput,
  OpensteerInteractionGetInput,
  OpensteerInteractionGetOutput,
  OpensteerInteractionReplayInput,
  OpensteerInteractionReplayOutput,
  OpensteerPageActivateInput,
  OpensteerPageActivateOutput,
  OpensteerPageCloseInput,
  OpensteerPageCloseOutput,
  OpensteerPageEvaluateInput,
  OpensteerPageEvaluateOutput,
  OpensteerPageGotoInput,
  OpensteerPageGotoOutput,
  OpensteerPageListInput,
  OpensteerPageListOutput,
  OpensteerPageNewInput,
  OpensteerPageNewOutput,
  OpensteerPageSnapshotInput,
  OpensteerPageSnapshotOutput,
  OpensteerRawRequestInput,
  OpensteerRawRequestOutput,
  OpensteerRequestExecuteInput,
  OpensteerRequestExecuteOutput,
  OpensteerRunRecipeInput,
  OpensteerRunRecipeOutput,
  OpensteerRunAuthRecipeInput,
  OpensteerRunAuthRecipeOutput,
  OpensteerScriptBeautifyInput,
  OpensteerScriptBeautifyOutput,
  OpensteerScriptDeobfuscateInput,
  OpensteerScriptDeobfuscateOutput,
  OpensteerScriptSandboxInput,
  OpensteerScriptSandboxOutput,
  OpensteerReverseExportInput,
  OpensteerReverseExportOutput,
  OpensteerReverseDiscoverInput,
  OpensteerReverseDiscoverOutput,
  OpensteerReverseQueryInput,
  OpensteerReverseQueryOutput,
  OpensteerReversePackageCreateInput,
  OpensteerReversePackageCreateOutput,
  OpensteerReversePackageGetInput,
  OpensteerReversePackageGetOutput,
  OpensteerReversePackageListInput,
  OpensteerReversePackageListOutput,
  OpensteerReversePackagePatchInput,
  OpensteerReversePackagePatchOutput,
  OpensteerReversePackageRunInput,
  OpensteerReversePackageRunOutput,
  OpensteerReverseReportInput,
  OpensteerReverseReportOutput,
  OpensteerSessionCloseOutput,
  OpensteerSessionOpenInput,
  OpensteerSessionOpenOutput,
  OpensteerTransportProbeInput,
  OpensteerTransportProbeOutput,
  OpensteerWriteRecipeInput,
  OpensteerWriteAuthRecipeInput,
  OpensteerWriteRequestPlanInput,
  StorageSnapshot,
} from "@opensteer/protocol";

import type { AuthRecipeRecord, RecipeRecord, RequestPlanRecord } from "../registry.js";
import type { OpensteerDisconnectableRuntime } from "../sdk/semantic-runtime.js";
import {
  removeOpensteerServiceMetadata,
  resolveOpensteerSessionRootPath,
  normalizeOpensteerSessionName,
} from "./metadata.js";
import {
  requireAttachedLocalOpensteerService,
  type OpensteerCliSessionOptions,
  type OpensteerSessionServiceClient,
} from "./client.js";

export class LocalOpensteerSessionProxy implements OpensteerDisconnectableRuntime {
  private client: OpensteerSessionServiceClient | undefined;

  constructor(private readonly options: OpensteerCliSessionOptions = {}) {}

  async open(input: OpensteerSessionOpenInput = {}): Promise<OpensteerSessionOpenOutput> {
    if (input.browser !== undefined || input.context !== undefined || input.name !== undefined) {
      throw new Error(
        "Attached Opensteer sessions do not accept browser, context, or name in open(). Attach to an existing session and pass only url if you want to navigate it.",
      );
    }

    return (await this.ensureClient()).invoke("session.open", {
      ...(input.url === undefined ? {} : { url: input.url }),
    });
  }

  async listPages(input: OpensteerPageListInput = {}): Promise<OpensteerPageListOutput> {
    return (await this.ensureClient()).invoke("page.list", input);
  }

  async newPage(input: OpensteerPageNewInput = {}): Promise<OpensteerPageNewOutput> {
    return (await this.ensureClient()).invoke("page.new", input);
  }

  async activatePage(input: OpensteerPageActivateInput): Promise<OpensteerPageActivateOutput> {
    return (await this.ensureClient()).invoke("page.activate", input);
  }

  async closePage(input: OpensteerPageCloseInput = {}): Promise<OpensteerPageCloseOutput> {
    return (await this.ensureClient()).invoke("page.close", input);
  }

  async goto(input: OpensteerPageGotoInput): Promise<OpensteerPageGotoOutput> {
    return (await this.ensureClient()).invoke("page.goto", input);
  }

  async evaluate(input: OpensteerPageEvaluateInput): Promise<OpensteerPageEvaluateOutput> {
    return (await this.ensureClient()).invoke("page.evaluate", input);
  }

  async addInitScript(input: OpensteerAddInitScriptInput): Promise<OpensteerAddInitScriptOutput> {
    return (await this.ensureClient()).invoke("page.add-init-script", input);
  }

  async snapshot(input: OpensteerPageSnapshotInput = {}): Promise<OpensteerPageSnapshotOutput> {
    return (await this.ensureClient()).invoke("page.snapshot", input);
  }

  async click(input: OpensteerDomClickInput): Promise<OpensteerActionResult> {
    return (await this.ensureClient()).invoke("dom.click", input);
  }

  async hover(input: OpensteerDomHoverInput): Promise<OpensteerActionResult> {
    return (await this.ensureClient()).invoke("dom.hover", input);
  }

  async input(input: OpensteerDomInputInput): Promise<OpensteerActionResult> {
    return (await this.ensureClient()).invoke("dom.input", input);
  }

  async scroll(input: OpensteerDomScrollInput): Promise<OpensteerActionResult> {
    return (await this.ensureClient()).invoke("dom.scroll", input);
  }

  async extract(input: OpensteerDomExtractInput): Promise<OpensteerDomExtractOutput> {
    return (await this.ensureClient()).invoke("dom.extract", input);
  }

  async queryNetwork(input: OpensteerNetworkQueryInput = {}): Promise<OpensteerNetworkQueryOutput> {
    return (await this.ensureClient()).invoke("network.query", input);
  }

  async saveNetwork(input: OpensteerNetworkSaveInput): Promise<OpensteerNetworkSaveOutput> {
    return (await this.ensureClient()).invoke("network.save", input);
  }

  async minimizeNetwork(
    input: OpensteerNetworkMinimizeInput,
  ): Promise<OpensteerNetworkMinimizeOutput> {
    return (await this.ensureClient()).invoke("network.minimize", input);
  }

  async diffNetwork(input: OpensteerNetworkDiffInput): Promise<OpensteerNetworkDiffOutput> {
    return (await this.ensureClient()).invoke("network.diff", input);
  }

  async probeNetwork(input: OpensteerTransportProbeInput): Promise<OpensteerTransportProbeOutput> {
    return (await this.ensureClient()).invoke("network.probe", input);
  }

  async discoverReverse(
    input: OpensteerReverseDiscoverInput,
  ): Promise<OpensteerReverseDiscoverOutput> {
    return (await this.ensureClient()).invoke("reverse.discover", input);
  }

  async queryReverse(input: OpensteerReverseQueryInput): Promise<OpensteerReverseQueryOutput> {
    return (await this.ensureClient()).invoke("reverse.query", input);
  }

  async createReversePackage(
    input: OpensteerReversePackageCreateInput,
  ): Promise<OpensteerReversePackageCreateOutput> {
    return (await this.ensureClient()).invoke("reverse.package.create", input);
  }

  async runReversePackage(
    input: OpensteerReversePackageRunInput,
  ): Promise<OpensteerReversePackageRunOutput> {
    return (await this.ensureClient()).invoke("reverse.package.run", input);
  }

  async exportReverse(input: OpensteerReverseExportInput): Promise<OpensteerReverseExportOutput> {
    return (await this.ensureClient()).invoke("reverse.export", input);
  }

  async getReverseReport(
    input: OpensteerReverseReportInput,
  ): Promise<OpensteerReverseReportOutput> {
    return (await this.ensureClient()).invoke("reverse.report", input);
  }

  async getReversePackage(
    input: OpensteerReversePackageGetInput,
  ): Promise<OpensteerReversePackageGetOutput> {
    return (await this.ensureClient()).invoke("reverse.package.get", input);
  }

  async listReversePackages(
    input: OpensteerReversePackageListInput = {},
  ): Promise<OpensteerReversePackageListOutput> {
    return (await this.ensureClient()).invoke("reverse.package.list", input);
  }

  async patchReversePackage(
    input: OpensteerReversePackagePatchInput,
  ): Promise<OpensteerReversePackagePatchOutput> {
    return (await this.ensureClient()).invoke("reverse.package.patch", input);
  }

  async captureInteraction(
    input: OpensteerInteractionCaptureInput,
  ): Promise<OpensteerInteractionCaptureOutput> {
    return (await this.ensureClient()).invoke("interaction.capture", input);
  }

  async getInteraction(
    input: OpensteerInteractionGetInput,
  ): Promise<OpensteerInteractionGetOutput> {
    return (await this.ensureClient()).invoke("interaction.get", input);
  }

  async diffInteraction(
    input: OpensteerInteractionDiffInput,
  ): Promise<OpensteerInteractionDiffOutput> {
    return (await this.ensureClient()).invoke("interaction.diff", input);
  }

  async replayInteraction(
    input: OpensteerInteractionReplayInput,
  ): Promise<OpensteerInteractionReplayOutput> {
    return (await this.ensureClient()).invoke("interaction.replay", input);
  }

  async clearNetwork(input: OpensteerNetworkClearInput = {}): Promise<OpensteerNetworkClearOutput> {
    return (await this.ensureClient()).invoke("network.clear", input);
  }

  async captureScripts(
    input: OpensteerCaptureScriptsInput = {},
  ): Promise<OpensteerCaptureScriptsOutput> {
    return (await this.ensureClient()).invoke("scripts.capture", input);
  }

  async readArtifact(input: OpensteerArtifactReadInput): Promise<OpensteerArtifactReadOutput> {
    return (await this.ensureClient()).invoke("artifact.read", input);
  }

  async beautifyScript(
    input: OpensteerScriptBeautifyInput,
  ): Promise<OpensteerScriptBeautifyOutput> {
    return (await this.ensureClient()).invoke("scripts.beautify", input);
  }

  async deobfuscateScript(
    input: OpensteerScriptDeobfuscateInput,
  ): Promise<OpensteerScriptDeobfuscateOutput> {
    return (await this.ensureClient()).invoke("scripts.deobfuscate", input);
  }

  async sandboxScript(input: OpensteerScriptSandboxInput): Promise<OpensteerScriptSandboxOutput> {
    return (await this.ensureClient()).invoke("scripts.sandbox", input);
  }

  async solveCaptcha(input: OpensteerCaptchaSolveInput): Promise<OpensteerCaptchaSolveOutput> {
    return (await this.ensureClient()).invoke("captcha.solve", input);
  }

  async getCookies(
    input: { readonly urls?: readonly string[] } = {},
  ): Promise<readonly CookieRecord[]> {
    return (await this.ensureClient()).invoke("inspect.cookies", input);
  }

  async getStorageSnapshot(
    input: {
      readonly includeSessionStorage?: boolean;
      readonly includeIndexedDb?: boolean;
    } = {},
  ): Promise<StorageSnapshot> {
    return (await this.ensureClient()).invoke("inspect.storage", input);
  }

  async rawRequest(input: OpensteerRawRequestInput): Promise<OpensteerRawRequestOutput> {
    return (await this.ensureClient()).invoke("request.raw", input);
  }

  async inferRequestPlan(input: OpensteerInferRequestPlanInput): Promise<RequestPlanRecord> {
    return (await this.ensureClient()).invoke("request-plan.infer", input);
  }

  async writeRequestPlan(input: OpensteerWriteRequestPlanInput): Promise<RequestPlanRecord> {
    return (await this.ensureClient()).invoke("request-plan.write", input);
  }

  async getRequestPlan(input: OpensteerGetRequestPlanInput): Promise<RequestPlanRecord> {
    return (await this.ensureClient()).invoke("request-plan.get", input);
  }

  async listRequestPlans(
    input: OpensteerListRequestPlansInput = {},
  ): Promise<OpensteerListRequestPlansOutput> {
    return (await this.ensureClient()).invoke("request-plan.list", input);
  }

  async writeAuthRecipe(input: OpensteerWriteAuthRecipeInput): Promise<AuthRecipeRecord> {
    return (await this.ensureClient()).invoke("auth-recipe.write", input);
  }

  async writeRecipe(input: OpensteerWriteRecipeInput): Promise<RecipeRecord> {
    return (await this.ensureClient()).invoke("recipe.write", input);
  }

  async getAuthRecipe(input: OpensteerGetAuthRecipeInput): Promise<AuthRecipeRecord> {
    return (await this.ensureClient()).invoke("auth-recipe.get", input);
  }

  async getRecipe(input: OpensteerGetRecipeInput): Promise<RecipeRecord> {
    return (await this.ensureClient()).invoke("recipe.get", input);
  }

  async listAuthRecipes(
    input: OpensteerListAuthRecipesInput = {},
  ): Promise<OpensteerListAuthRecipesOutput> {
    return (await this.ensureClient()).invoke("auth-recipe.list", input);
  }

  async listRecipes(input: OpensteerListRecipesInput = {}): Promise<OpensteerListRecipesOutput> {
    return (await this.ensureClient()).invoke("recipe.list", input);
  }

  async runAuthRecipe(input: OpensteerRunAuthRecipeInput): Promise<OpensteerRunAuthRecipeOutput> {
    return (await this.ensureClient()).invoke("auth-recipe.run", input);
  }

  async runRecipe(input: OpensteerRunRecipeInput): Promise<OpensteerRunRecipeOutput> {
    return (await this.ensureClient()).invoke("recipe.run", input);
  }

  async request(input: OpensteerRequestExecuteInput): Promise<OpensteerRequestExecuteOutput> {
    return (await this.ensureClient()).invoke("request.execute", input);
  }

  async computerExecute(
    input: OpensteerComputerExecuteInput,
  ): Promise<OpensteerComputerExecuteOutput> {
    return (await this.ensureClient()).invoke("computer.execute", input);
  }

  async close(): Promise<OpensteerSessionCloseOutput> {
    try {
      const result = await (await this.ensureClient()).closeSession();
      await removeOpensteerServiceMetadata(
        resolveOpensteerSessionRootPath(this.options.rootDir),
        normalizeOpensteerSessionName(this.options.name),
      ).catch(() => undefined);
      return result;
    } finally {
      this.client = undefined;
    }
  }

  async disconnect(): Promise<void> {
    this.client = undefined;
  }

  private async ensureClient(): Promise<OpensteerSessionServiceClient> {
    if (!this.client) {
      this.client = await requireAttachedLocalOpensteerService(this.options);
    }

    return this.client;
  }
}
