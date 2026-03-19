import type {
  CookieRecord,
  OpensteerAddInitScriptInput,
  OpensteerAddInitScriptOutput,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerCaptureScriptsInput,
  OpensteerCaptureScriptsOutput,
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
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkSaveInput,
  OpensteerNetworkSaveOutput,
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
  OpensteerSessionCloseOutput,
  OpensteerSessionOpenInput,
  OpensteerSessionOpenOutput,
  OpensteerWriteRecipeInput,
  OpensteerWriteAuthRecipeInput,
  OpensteerWriteRequestPlanInput,
  OpensteerActionResult,
  StorageSnapshot,
} from "@opensteer/protocol";

import type { AuthRecipeRecord, RecipeRecord, RequestPlanRecord } from "../registry.js";
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

  async listPages(input: OpensteerPageListInput = {}): Promise<OpensteerPageListOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.list", input);
  }

  async newPage(input: OpensteerPageNewInput = {}): Promise<OpensteerPageNewOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.new", input);
  }

  async activatePage(input: OpensteerPageActivateInput): Promise<OpensteerPageActivateOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.activate", input);
  }

  async closePage(input: OpensteerPageCloseInput = {}): Promise<OpensteerPageCloseOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.close", input);
  }

  async goto(input: OpensteerPageGotoInput): Promise<OpensteerPageGotoOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.goto", input);
  }

  async evaluate(input: OpensteerPageEvaluateInput): Promise<OpensteerPageEvaluateOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.evaluate", input);
  }

  async addInitScript(input: OpensteerAddInitScriptInput): Promise<OpensteerAddInitScriptOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.add-init-script", input);
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

  async captureScripts(
    input: OpensteerCaptureScriptsInput = {},
  ): Promise<OpensteerCaptureScriptsOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("scripts.capture", input);
  }

  async getCookies(
    input: { readonly urls?: readonly string[] } = {},
  ): Promise<readonly CookieRecord[]> {
    await this.ensureSession();
    return this.requireClient().invoke("inspect.cookies", input);
  }

  async getStorageSnapshot(
    input: {
      readonly includeSessionStorage?: boolean;
      readonly includeIndexedDb?: boolean;
    } = {},
  ): Promise<StorageSnapshot> {
    await this.ensureSession();
    return this.requireClient().invoke("inspect.storage", input);
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

  async writeAuthRecipe(input: OpensteerWriteAuthRecipeInput): Promise<AuthRecipeRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("auth-recipe.write", input);
  }

  async writeRecipe(input: OpensteerWriteRecipeInput): Promise<RecipeRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("recipe.write", input);
  }

  async getAuthRecipe(input: OpensteerGetAuthRecipeInput): Promise<AuthRecipeRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("auth-recipe.get", input);
  }

  async getRecipe(input: OpensteerGetRecipeInput): Promise<RecipeRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("recipe.get", input);
  }

  async listAuthRecipes(
    input: OpensteerListAuthRecipesInput = {},
  ): Promise<OpensteerListAuthRecipesOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("auth-recipe.list", input);
  }

  async listRecipes(input: OpensteerListRecipesInput = {}): Promise<OpensteerListRecipesOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("recipe.list", input);
  }

  async runAuthRecipe(input: OpensteerRunAuthRecipeInput): Promise<OpensteerRunAuthRecipeOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("auth-recipe.run", input);
  }

  async runRecipe(input: OpensteerRunRecipeInput): Promise<OpensteerRunRecipeOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("recipe.run", input);
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
