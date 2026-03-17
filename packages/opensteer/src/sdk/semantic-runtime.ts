import type {
  CookieRecord,
  OpensteerActionResult,
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
  OpensteerListAuthRecipesInput,
  OpensteerListAuthRecipesOutput,
  OpensteerListRequestPlansInput,
  OpensteerListRequestPlansOutput,
  OpensteerNetworkClearInput,
  OpensteerNetworkClearOutput,
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkSaveInput,
  OpensteerNetworkSaveOutput,
  OpensteerPageGotoInput,
  OpensteerPageGotoOutput,
  OpensteerPageSnapshotInput,
  OpensteerPageSnapshotOutput,
  OpensteerRawRequestInput,
  OpensteerRawRequestOutput,
  OpensteerRequestExecuteInput,
  OpensteerRequestExecuteOutput,
  OpensteerRunAuthRecipeInput,
  OpensteerRunAuthRecipeOutput,
  OpensteerSessionCloseOutput,
  OpensteerSessionOpenInput,
  OpensteerSessionOpenOutput,
  OpensteerWriteAuthRecipeInput,
  OpensteerWriteRequestPlanInput,
  StorageSnapshot,
} from "@opensteer/protocol";

import type { AuthRecipeRecord, RequestPlanRecord } from "../registry.js";

export interface OpensteerRuntimeOperationOptions {
  readonly signal?: AbortSignal;
}

export interface OpensteerSemanticRuntime {
  open(
    input?: OpensteerSessionOpenInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerSessionOpenOutput>;
  goto(
    input: OpensteerPageGotoInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerPageGotoOutput>;
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
  clearNetwork(
    input?: OpensteerNetworkClearInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerNetworkClearOutput>;
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
  getAuthRecipe(
    input: OpensteerGetAuthRecipeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<AuthRecipeRecord>;
  listAuthRecipes(
    input?: OpensteerListAuthRecipesInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerListAuthRecipesOutput>;
  runAuthRecipe(
    input: OpensteerRunAuthRecipeInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerRunAuthRecipeOutput>;
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
