import type { AttachmentStore } from "@opensteer/database";
import { AttachmentService } from "../attachments/attachment-service.js";
import type { ProjectCapabilityTokenService } from "./run-capability.js";

export class ProjectAttachmentReader {
  readonly #attachments: AttachmentService;
  readonly #capabilities: ProjectCapabilityTokenService;

  constructor(input: {
    readonly dataDirectory: string;
    readonly store: AttachmentStore;
    readonly capabilities: ProjectCapabilityTokenService;
  }) {
    this.#capabilities = input.capabilities;
    this.#attachments = new AttachmentService({
      ...input,
      runTokens: {
        authenticate: (token) =>
          input.capabilities.verify(token, "opensteer-project-run-attachments"),
      },
    });
  }

  async listForRun(token: string, after: string | null) {
    const result = await this.#attachments.listForRun(token, after);
    await this.#capabilities.verify(token, "opensteer-project-run-attachments");
    return result;
  }

  async contentForRun(token: string, attachmentId: string) {
    const result = await this.#attachments.contentForRun(token, attachmentId);
    await this.#capabilities.verify(token, "opensteer-project-run-attachments");
    return result;
  }
}
