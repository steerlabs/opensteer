import {
  OpensteerError,
  type ComputerFolder,
  type EnvironmentId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";

/** Who owns this personal Opensteer, and the one computer, environment and folder its agents work in. */
export class PersonalExecution {
  readonly options: {
    readonly hostingComputerId: RunnerId;
    readonly ownerId: UserId;
    readonly environmentId: EnvironmentId;
    readonly agentHome: ComputerFolder;
    readonly assertOwner: (ownerId: UserId) => Promise<void>;
  };
  constructor(options: PersonalExecution["options"]) {
    this.options = options;
  }

  canExecute(environmentId: EnvironmentId): boolean {
    return environmentId === this.options.environmentId;
  }

  /** The environment the owner's tasks run in. */
  async environmentFor(ownerId: UserId): Promise<EnvironmentId> {
    await this.options.assertOwner(ownerId);
    if (ownerId !== this.options.ownerId)
      throw new OpensteerError({ code: "forbidden", message: "The personal owner is required." });
    return this.options.environmentId;
  }
}
