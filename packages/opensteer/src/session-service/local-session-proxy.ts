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

  async goto(input: OpensteerPageGotoInput): Promise<OpensteerPageGotoOutput> {
    return (await this.ensureClient()).invoke("page.goto", input);
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

  async clearNetwork(input: OpensteerNetworkClearInput = {}): Promise<OpensteerNetworkClearOutput> {
    return (await this.ensureClient()).invoke("network.clear", input);
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
