import type {
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
  OpensteerActionResult,
} from "@opensteer/protocol";

import type { RequestPlanRecord } from "../registry.js";
import {
  OpensteerCliServiceClient,
  type OpensteerServiceConnection,
} from "../session-service/client.js";
import type { OpensteerSemanticRuntime } from "../sdk/semantic-runtime.js";
import { OpensteerCloudClient } from "./client.js";

export class CloudSessionProxy implements OpensteerSemanticRuntime {
  private sessionId: string | undefined;
  private client: OpensteerCliServiceClient | undefined;

  constructor(
    private readonly cloud: OpensteerCloudClient,
    private readonly name?: string,
  ) {}

  async open(input: OpensteerSessionOpenInput = {}): Promise<OpensteerSessionOpenOutput> {
    await this.ensureSession({
      ...(input.browser === undefined ? {} : { browser: input.browser }),
      ...(input.context === undefined ? {} : { context: input.context }),
    });
    return this.requireClient().invoke("session.open", {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.url === undefined ? {} : { url: input.url }),
    });
  }

  async goto(input: OpensteerPageGotoInput): Promise<OpensteerPageGotoOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.goto", input);
  }

  async snapshot(input: OpensteerPageSnapshotInput = {}): Promise<OpensteerPageSnapshotOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.snapshot", input);
  }

  async click(input: OpensteerDomClickInput): Promise<OpensteerActionResult> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.click", input);
  }

  async hover(input: OpensteerDomHoverInput): Promise<OpensteerActionResult> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.hover", input);
  }

  async input(input: OpensteerDomInputInput): Promise<OpensteerActionResult> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.input", input);
  }

  async scroll(input: OpensteerDomScrollInput): Promise<OpensteerActionResult> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.scroll", input);
  }

  async extract(input: OpensteerDomExtractInput): Promise<OpensteerDomExtractOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.extract", input);
  }

  async queryNetwork(input: OpensteerNetworkQueryInput = {}): Promise<OpensteerNetworkQueryOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("network.query", input);
  }

  async saveNetwork(input: OpensteerNetworkSaveInput): Promise<OpensteerNetworkSaveOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("network.save", input);
  }

  async clearNetwork(input: OpensteerNetworkClearInput = {}): Promise<OpensteerNetworkClearOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("network.clear", input);
  }

  async rawRequest(input: OpensteerRawRequestInput): Promise<OpensteerRawRequestOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("request.raw", input);
  }

  async inferRequestPlan(input: OpensteerInferRequestPlanInput): Promise<RequestPlanRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("request-plan.infer", input);
  }

  async writeRequestPlan(input: OpensteerWriteRequestPlanInput): Promise<RequestPlanRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("request-plan.write", input);
  }

  async getRequestPlan(input: OpensteerGetRequestPlanInput): Promise<RequestPlanRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("request-plan.get", input);
  }

  async listRequestPlans(
    input: OpensteerListRequestPlansInput = {},
  ): Promise<OpensteerListRequestPlansOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("request-plan.list", input);
  }

  async request(input: OpensteerRequestExecuteInput): Promise<OpensteerRequestExecuteOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("request.execute", input);
  }

  async computerExecute(
    input: OpensteerComputerExecuteInput,
  ): Promise<OpensteerComputerExecuteOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("computer.execute", input);
  }

  async close(): Promise<OpensteerSessionCloseOutput> {
    if (!this.client || !this.sessionId) {
      return { closed: true };
    }

    await this.client.invoke("session.close", {}).catch(() => undefined);
    await this.cloud.closeSession(this.sessionId);
    this.client = undefined;
    this.sessionId = undefined;
    return { closed: true };
  }

  private async ensureSession(input?: {
    readonly browser?: OpensteerSessionOpenInput["browser"];
    readonly context?: OpensteerSessionOpenInput["context"];
    readonly browserProfile?: import("@opensteer/cloud-contracts").CloudBrowserProfilePreference;
  }): Promise<void> {
    if (this.client) {
      return;
    }

    const session = await this.cloud.createSession({
      ...(this.name === undefined ? {} : { name: this.name }),
      ...(input?.browser === undefined ? {} : { browser: input.browser }),
      ...(input?.context === undefined ? {} : { context: input.context }),
      ...(input?.browserProfile === undefined
        ? this.cloud.getConfig().browserProfile === undefined
          ? {}
          : { browserProfile: this.cloud.getConfig().browserProfile }
        : { browserProfile: input.browserProfile }),
    });
    this.sessionId = session.sessionId;
    const connection: OpensteerServiceConnection = {
      baseUrl: session.baseUrl,
      getAuthorizationHeader: async () => this.cloud.buildAuthorizationHeader(),
    };
    this.client = OpensteerCliServiceClient.fromConnection(connection);
  }

  private requireClient(): OpensteerCliServiceClient {
    if (!this.client) {
      throw new Error("Cloud session has not been initialized.");
    }
    return this.client;
  }
}
