import type {
  OpensteerActionResult,
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
  OpensteerSessionCloseOutput,
  OpensteerSessionOpenInput,
  OpensteerSessionOpenOutput,
  OpensteerWriteRequestPlanInput,
} from "@opensteer/protocol";

import type { RequestPlanRecord } from "../registry.js";

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
