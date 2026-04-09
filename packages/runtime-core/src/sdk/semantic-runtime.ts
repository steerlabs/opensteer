import type {
  OpensteerArtifactReadInput,
  OpensteerArtifactReadOutput,
  OpensteerCaptchaSolveInput,
  OpensteerCaptchaSolveOutput,
  OpensteerActionResult,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerDomClickInput,
  OpensteerDomExtractInput,
  OpensteerDomExtractOutput,
  OpensteerDomHoverInput,
  OpensteerDomInputInput,
  OpensteerDomScrollInput,
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkDetailOutput,
  OpensteerCookieQueryInput,
  OpensteerCookieQueryOutput,
  OpensteerStorageQueryInput,
  OpensteerStorageQueryOutput,
  OpensteerStateQueryInput,
  OpensteerStateQueryOutput,
  OpensteerSessionFetchInput,
  OpensteerSessionFetchOutput,
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
  OpensteerSessionInfo,
  OpensteerSessionCloseOutput,
  OpensteerOpenInput,
  OpensteerOpenOutput,
} from "@opensteer/protocol";

export interface OpensteerRuntimeOperationOptions {
  readonly signal?: AbortSignal;
}

export interface OpensteerSemanticRuntime {
  info(options?: OpensteerRuntimeOperationOptions): Promise<OpensteerSessionInfo>;
  open(
    input?: OpensteerOpenInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerOpenOutput>;
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
  getNetworkDetail(
    input: {
      readonly recordId: string;
      readonly probe?: boolean;
    },
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerNetworkDetailOutput>;
  captureInteraction(
    input: OpensteerInteractionCaptureInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerInteractionCaptureOutput>;
  getInteraction(
    input: OpensteerInteractionGetInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerInteractionGetOutput>;
  diffInteraction(
    input: OpensteerInteractionDiffInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerInteractionDiffOutput>;
  replayInteraction(
    input: OpensteerInteractionReplayInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerInteractionReplayOutput>;
  captureScripts(
    input?: OpensteerCaptureScriptsInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerCaptureScriptsOutput>;
  readArtifact(
    input: OpensteerArtifactReadInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerArtifactReadOutput>;
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
    input?: OpensteerCookieQueryInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerCookieQueryOutput>;
  getStorageSnapshot(
    input?: OpensteerStorageQueryInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerStorageQueryOutput>;
  getBrowserState(
    input?: OpensteerStateQueryInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerStateQueryOutput>;
  fetch(
    input: OpensteerSessionFetchInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerSessionFetchOutput>;
  computerExecute(
    input: OpensteerComputerExecuteInput,
    options?: OpensteerRuntimeOperationOptions,
  ): Promise<OpensteerComputerExecuteOutput>;
  close(options?: OpensteerRuntimeOperationOptions): Promise<OpensteerSessionCloseOutput>;
}

export interface OpensteerDisconnectableRuntime extends OpensteerSemanticRuntime {
  disconnect(): Promise<void>;
}
