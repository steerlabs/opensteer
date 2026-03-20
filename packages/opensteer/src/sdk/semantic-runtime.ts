import type {
  CookieRecord,
  OpensteerCaptchaSolveInput,
  OpensteerCaptchaSolveOutput,
  OpensteerActionResult,
  OpensteerGetRecipeInput,
  OpensteerGetAuthRecipeInput,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerDomClickInput,
  OpensteerDomExtractInput,
  OpensteerDomExtractOutput,
  OpensteerDomHoverInput,
  OpensteerDomInputInput,
  OpensteerDomScrollInput,
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
  OpensteerTransportProbeInput,
  OpensteerTransportProbeOutput,
  OpensteerPageActivateInput,
  OpensteerPageActivateOutput,
  OpensteerAddInitScriptInput,
  OpensteerAddInitScriptOutput,
  OpensteerCaptureScriptsInput,
  OpensteerCaptureScriptsOutput,
  OpensteerScriptBeautifyInput,
  OpensteerScriptBeautifyOutput,
  OpensteerScriptDeobfuscateInput,
  OpensteerScriptDeobfuscateOutput,
  OpensteerScriptSandboxInput,
  OpensteerScriptSandboxOutput,
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
  OpensteerSessionCloseOutput,
  OpensteerSessionOpenInput,
  OpensteerSessionOpenOutput,
  OpensteerWriteRecipeInput,
  OpensteerWriteAuthRecipeInput,
  OpensteerWriteRequestPlanInput,
  StorageSnapshot,
} from "@opensteer/protocol";

import type { AuthRecipeRecord, RecipeRecord, RequestPlanRecord } from "../registry.js";

export interface OpensteerRuntimeOperationOptions {
  readonly signal?: AbortSignal;
}

export interface OpensteerSemanticRuntime {
  open(
    input?: OpensteerSessionOpenInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerSessionOpenOutput>;
  listPages(
    input?: OpensteerPageListInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerPageListOutput>;
  newPage(
    input?: OpensteerPageNewInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerPageNewOutput>;
  activatePage(
    input: OpensteerPageActivateInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerPageActivateOutput>;
  closePage(
    input?: OpensteerPageCloseInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerPageCloseOutput>;
  goto(
    input: OpensteerPageGotoInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerPageGotoOutput>;
  evaluate(
    input: OpensteerPageEvaluateInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerPageEvaluateOutput>;
  addInitScript(
    input: OpensteerAddInitScriptInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerAddInitScriptOutput>;
  snapshot(
    input?: OpensteerPageSnapshotInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerPageSnapshotOutput>;
  click(
    input: OpensteerDomClickInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerActionResult>;
  hover(
    input: OpensteerDomHoverInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerActionResult>;
  input(
    input: OpensteerDomInputInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerActionResult>;
  scroll(
    input: OpensteerDomScrollInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerActionResult>;
  extract(
    input: OpensteerDomExtractInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerDomExtractOutput>;
  queryNetwork(
    input?: OpensteerNetworkQueryInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerNetworkQueryOutput>;
  saveNetwork(
    input: OpensteerNetworkSaveInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerNetworkSaveOutput>;
  minimizeNetwork(
    input: OpensteerNetworkMinimizeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerNetworkMinimizeOutput>;
  diffNetwork(
    input: OpensteerNetworkDiffInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerNetworkDiffOutput>;
  probeNetwork(
    input: OpensteerTransportProbeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerTransportProbeOutput>;
  clearNetwork(
    input?: OpensteerNetworkClearInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerNetworkClearOutput>;
  captureScripts(
    input?: OpensteerCaptureScriptsInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerCaptureScriptsOutput>;
  beautifyScript(
    input: OpensteerScriptBeautifyInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerScriptBeautifyOutput>;
  deobfuscateScript(
    input: OpensteerScriptDeobfuscateInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerScriptDeobfuscateOutput>;
  sandboxScript(
    input: OpensteerScriptSandboxInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerScriptSandboxOutput>;
  solveCaptcha(
    input: OpensteerCaptchaSolveInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerCaptchaSolveOutput>;
  getCookies(
    input?: {
      readonly urls?: readonly string[];
    },
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<readonly CookieRecord[]>;
  getStorageSnapshot(
    input?: {
      readonly includeSessionStorage?: boolean;
      readonly includeIndexedDb?: boolean;
    },
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<StorageSnapshot>;
  rawRequest(
    input: OpensteerRawRequestInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerRawRequestOutput>;
  inferRequestPlan(
    input: OpensteerInferRequestPlanInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<RequestPlanRecord>;
  writeRequestPlan(
    input: OpensteerWriteRequestPlanInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<RequestPlanRecord>;
  getRequestPlan(
    input: OpensteerGetRequestPlanInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<RequestPlanRecord>;
  listRequestPlans(
    input?: OpensteerListRequestPlansInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerListRequestPlansOutput>;
  writeAuthRecipe(
    input: OpensteerWriteAuthRecipeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<AuthRecipeRecord>;
  writeRecipe(
    input: OpensteerWriteRecipeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<RecipeRecord>;
  getAuthRecipe(
    input: OpensteerGetAuthRecipeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<AuthRecipeRecord>;
  getRecipe(
    input: OpensteerGetRecipeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<RecipeRecord>;
  listAuthRecipes(
    input?: OpensteerListAuthRecipesInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerListAuthRecipesOutput>;
  listRecipes(
    input?: OpensteerListRecipesInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerListRecipesOutput>;
  runAuthRecipe(
    input: OpensteerRunAuthRecipeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerRunAuthRecipeOutput>;
  runRecipe(
    input: OpensteerRunRecipeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerRunRecipeOutput>;
  request(
    input: OpensteerRequestExecuteInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerRequestExecuteOutput>;
  computerExecute(
    input: OpensteerComputerExecuteInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerComputerExecuteOutput>;
  close(options?: OpensteerRuntimeOperationOptions): Promise<OpensteerSessionCloseOutput>;
}

export interface OpensteerDisconnectableRuntime extends OpensteerSemanticRuntime {
  disconnect(): Promise<void>;
}
