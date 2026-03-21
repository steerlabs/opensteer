import type {
  JsonValue,
  OpensteerExecutableResolver,
  OpensteerReplayStrategy,
  OpensteerReverseCandidateRecord,
  OpensteerReverseGuardRecord,
  OpensteerReverseManualCalibrationMode,
  OpensteerReverseObservationRecord,
  OpensteerReversePackageKind,
  OpensteerReversePackageReadiness,
  OpensteerReversePackageRequirements,
  OpensteerReverseRequirement,
  OpensteerReverseSuggestedEdit,
  OpensteerReverseWorkflowStep,
  OpensteerStateSourceKind,
  OpensteerValidationRule,
} from "@opensteer/protocol";

export function buildReversePackageWorkflow(input: {
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly strategy?: OpensteerReplayStrategy;
  readonly observation?: OpensteerReverseObservationRecord;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly validators: readonly OpensteerValidationRule[];
  readonly executeStepInput?: JsonValue;
}): readonly OpensteerReverseWorkflowStep[] {
  const candidate = input.candidate;
  const strategy = input.strategy;
  if (candidate === undefined || strategy === undefined) {
    return [];
  }

  const steps: OpensteerReverseWorkflowStep[] = [];
  if (strategy.execution === "page-observation" && input.observation?.url !== undefined) {
    steps.push({
      id: `workflow:goto:${candidate.id}`,
      kind: "operation",
      label: `Open ${input.observation.url}`,
      operation: "page.goto",
      input: { url: input.observation.url },
    });
  }

  for (const guardId of strategy.guardIds) {
    const guard = input.guards.find((entry) => entry.id === guardId);
    if (guard?.interactionTraceId === undefined) {
      continue;
    }
    steps.push({
      id: `workflow:guard:${guard.id}`,
      kind: "operation",
      label: guard.label,
      operation: "interaction.replay",
      input: {
        traceId: guard.interactionTraceId,
      },
      bindAs: `trace:${guard.id}`,
    });
  }

  if (strategy.execution === "page-observation") {
    steps.push({
      id: `workflow:await:${candidate.id}`,
      kind: "await-record",
      label: `Wait for ${candidate.channel.url}`,
      channel: candidate.channel,
      recordId: candidate.recordId,
      validationRuleIds: input.validators.map((validator) => validator.id),
      bindAs: "observed-record",
    });
  } else if (input.executeStepInput !== undefined) {
    steps.push({
      id: `workflow:execute:${candidate.id}`,
      kind: "operation",
      label: `Execute ${candidate.channel.kind} replay`,
      operation: "request.raw",
      input: input.executeStepInput,
      bindAs: "channel-response",
    });
  }

  steps.push({
    id: `workflow:assert:${candidate.id}`,
    kind: "assert",
    label: "Validate replay result against captured success",
    validationRuleIds: input.validators.map((validator) => validator.id),
    binding: strategy.execution === "page-observation" ? "observed-record" : "channel-response",
  });
  return steps;
}

export function buildReversePackageRequirements(input: {
  readonly stateSource: OpensteerStateSourceKind;
  readonly strategy?: OpensteerReplayStrategy;
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly manualCalibration?: OpensteerReverseManualCalibrationMode;
}): OpensteerReversePackageRequirements {
  const stateSources = dedupeStateSources([
    input.stateSource,
    ...(input.strategy === undefined ? [] : [input.strategy.stateSource]),
  ]);
  return {
    requiresBrowser:
      input.strategy?.requiresBrowser ?? input.candidate?.dependencyClass !== "portable",
    requiresLiveState: input.strategy?.requiresLiveState ?? false,
    manualCalibration: classifyManualCalibrationRequirement(
      input.candidate,
      input.manualCalibration,
    ),
    stateSources,
  };
}

export function deriveReversePackageKind(input: {
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly strategy?: OpensteerReplayStrategy;
}): OpensteerReversePackageKind {
  if (input.strategy?.execution === "page-observation") {
    return "browser-workflow";
  }
  if (input.candidate?.dependencyClass === "portable") {
    return "portable-http";
  }
  return "browser-workflow";
}

export function deriveReversePackageUnresolvedRequirements(input: {
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly strategy?: OpensteerReplayStrategy;
  readonly workflow: readonly OpensteerReverseWorkflowStep[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly stateSource: OpensteerStateSourceKind;
}): readonly OpensteerReverseRequirement[] {
  const requirements: OpensteerReverseRequirement[] = [];
  if (input.candidate === undefined) {
    requirements.push({
      id: "requirement:no-candidate",
      kind: "unsupported",
      status: "required",
      label: "No replay candidate was selected",
      description: "Pick a captured candidate request before replay can be edited or executed.",
      blocking: true,
    });
    return requirements;
  }

  if (input.candidate.dependencyClass === "blocked") {
    requirements.push({
      id: `requirement:unsupported:${input.candidate.id}`,
      kind: "unsupported",
      status: "required",
      label: "Candidate is outside the supported reverse-engineering scope",
      description:
        "This candidate was classified as blocked or opaque and cannot be replayed directly.",
      blocking: true,
      recordId: input.candidate.recordId,
    });
  }

  if (input.strategy === undefined) {
    requirements.push({
      id: `requirement:no-strategy:${input.candidate.id}`,
      kind: "workflow-step",
      status: "required",
      label: "No replay strategy is attached",
      description: "Pick or author a strategy before replay can run.",
      blocking: true,
      recordId: input.candidate.recordId,
    });
  } else if (!input.strategy.supported) {
    requirements.push({
      id: `requirement:strategy:${input.strategy.id}`,
      kind: input.candidate.dependencyClass === "blocked" ? "unsupported" : "channel",
      status: "required",
      label: input.strategy.failureReason ?? "Strategy is not runnable as generated",
      ...(input.strategy.failureReason === undefined
        ? {}
        : { description: input.strategy.failureReason }),
      blocking: true,
      recordId: input.candidate.recordId,
    });
  }

  if (input.workflow.length === 0) {
    requirements.push({
      id: `requirement:workflow:${input.candidate.id}`,
      kind: "workflow-step",
      status: "required",
      label: "Package workflow is empty",
      description: "Add package steps before replay can run.",
      blocking: true,
      recordId: input.candidate.recordId,
    });
  }

  const referencedResolverIds = collectReferencedResolverIds(input.workflow);
  const requireAllResolvers = input.strategy?.execution !== "page-observation";

  for (const guardId of input.candidate.guardIds ?? []) {
    const guard = input.guards.find((entry) => entry.id === guardId);
    if (guard?.status === "satisfied") {
      continue;
    }
    requirements.push({
      id: `requirement:guard:${guardId}`,
      kind: "guard",
      status: "required",
      label: guard?.label ?? `Unresolved guard ${guardId}`,
      description:
        guard?.notes ??
        "Attach a successful unlock trace or author package steps that satisfy this guard.",
      blocking: true,
      guardId,
      ...(guard?.interactionTraceId === undefined ? {} : { traceId: guard.interactionTraceId }),
    });
  }

  for (const resolver of input.resolvers) {
    if (!requireAllResolvers && !referencedResolverIds.has(resolver.id)) {
      continue;
    }
    if (resolver.status === "ready") {
      continue;
    }
    requirements.push({
      id: `requirement:resolver:${resolver.id}`,
      kind: "resolver",
      status: "required",
      label: resolver.label,
      description:
        resolver.description ?? "Provide a resolver value or binding before replay can run.",
      blocking: true,
      resolverId: resolver.id,
      ...(resolver.inputNames === undefined ? {} : { inputNames: resolver.inputNames }),
      ...(resolver.traceId === undefined ? {} : { traceId: resolver.traceId }),
      ...(resolver.artifactId === undefined && resolver.scriptArtifactId === undefined
        ? {}
        : { artifactId: resolver.artifactId ?? resolver.scriptArtifactId }),
      ...(resolver.sourceRecordId === undefined ? {} : { recordId: resolver.sourceRecordId }),
    });
  }

  if (input.strategy?.requiresLiveState === true && input.stateSource !== "attach-live") {
    requirements.push({
      id: `requirement:state:${input.candidate.id}`,
      kind: "state",
      status: "recommended",
      label: "Live browser state may still be required",
      description:
        "Replay strategy expects live state. Consider using attach-live or patching the package to reacquire the state.",
      blocking: false,
      recordId: input.candidate.recordId,
    });
  }

  return dedupeRequirements(requirements);
}

export function deriveReversePackageReadiness(input: {
  readonly kind: OpensteerReversePackageKind;
  readonly unresolvedRequirements: readonly OpensteerReverseRequirement[];
}): OpensteerReversePackageReadiness {
  if (input.unresolvedRequirements.some((requirement) => requirement.kind === "unsupported")) {
    return "unsupported";
  }
  if (input.unresolvedRequirements.some((requirement) => requirement.blocking)) {
    return "draft";
  }
  return "runnable";
}

export function buildReversePackageSuggestedEdits(
  unresolvedRequirements: readonly OpensteerReverseRequirement[],
): readonly OpensteerReverseSuggestedEdit[] {
  const suggestions = unresolvedRequirements.map((requirement) => {
    switch (requirement.kind) {
      case "resolver":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "set-resolver",
          label: `Patch resolver ${requirement.resolverId ?? requirement.label}`,
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.resolverId === undefined ? {} : { resolverId: requirement.resolverId }),
          ...(requirement.traceId === undefined ? {} : { traceId: requirement.traceId }),
          ...(requirement.artifactId === undefined ? {} : { artifactId: requirement.artifactId }),
          ...(requirement.recordId === undefined ? {} : { recordId: requirement.recordId }),
        } satisfies OpensteerReverseSuggestedEdit;
      case "guard":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "attach-trace",
          label: `Attach a trace for ${requirement.guardId ?? requirement.label}`,
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.guardId === undefined ? {} : { guardId: requirement.guardId }),
          ...(requirement.traceId === undefined ? {} : { traceId: requirement.traceId }),
        } satisfies OpensteerReverseSuggestedEdit;
      case "workflow-step":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "replace-workflow",
          label: "Patch the package workflow",
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.stepId === undefined ? {} : { stepId: requirement.stepId }),
        } satisfies OpensteerReverseSuggestedEdit;
      case "state":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "switch-state-source",
          label: "Switch replay to live state or add reacquisition steps",
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.recordId === undefined ? {} : { recordId: requirement.recordId }),
        } satisfies OpensteerReverseSuggestedEdit;
      case "unsupported":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "mark-unsupported",
          label: "Mark this package unsupported or choose another candidate",
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.recordId === undefined ? {} : { recordId: requirement.recordId }),
        } satisfies OpensteerReverseSuggestedEdit;
      default:
        return {
          id: `suggestion:${requirement.id}`,
          kind: "inspect-evidence",
          label: "Inspect linked reverse-engineering evidence",
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.traceId === undefined ? {} : { traceId: requirement.traceId }),
          ...(requirement.artifactId === undefined ? {} : { artifactId: requirement.artifactId }),
          ...(requirement.recordId === undefined ? {} : { recordId: requirement.recordId }),
        } satisfies OpensteerReverseSuggestedEdit;
    }
  });
  return dedupeSuggestedEdits(suggestions);
}

export function cloneReversePackageResolvers(
  resolvers: readonly OpensteerExecutableResolver[],
): readonly OpensteerExecutableResolver[] {
  return resolvers.map((resolver) => ({
    ...resolver,
    ...(resolver.inputNames === undefined ? {} : { inputNames: [...resolver.inputNames] }),
    ...(resolver.value === undefined ? {} : { value: resolver.value }),
  }));
}

function classifyManualCalibrationRequirement(
  candidate: OpensteerReverseCandidateRecord | undefined,
  manualCalibration: OpensteerReverseManualCalibrationMode | undefined,
): OpensteerReversePackageRequirements["manualCalibration"] {
  if (manualCalibration === "require") {
    return "required";
  }
  if (candidate?.dependencyClass === "behavior-gated") {
    return manualCalibration === "avoid" ? "recommended" : "required";
  }
  if (candidate?.dependencyClass === "anti-bot" || candidate?.dependencyClass === "script-signed") {
    return "recommended";
  }
  return "not-needed";
}

function dedupeStateSources(
  stateSources: readonly OpensteerStateSourceKind[],
): readonly OpensteerStateSourceKind[] {
  return [...new Set(stateSources)];
}

function collectReferencedResolverIds(
  workflow: readonly OpensteerReverseWorkflowStep[],
): ReadonlySet<string> {
  const resolverIds = new Set<string>();
  for (const step of workflow) {
    if (step.kind !== "operation") {
      continue;
    }
    visitResolverReferences(step.input, resolverIds);
  }
  return resolverIds;
}

function visitResolverReferences(value: unknown, resolverIds: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      visitResolverReferences(entry, resolverIds);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const resolverId =
    typeof (value as { readonly $resolver?: unknown }).$resolver === "string"
      ? (value as { readonly $resolver: string }).$resolver
      : undefined;
  if (resolverId !== undefined) {
    resolverIds.add(resolverId);
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    visitResolverReferences(entry, resolverIds);
  }
}

function dedupeRequirements(
  requirements: readonly OpensteerReverseRequirement[],
): readonly OpensteerReverseRequirement[] {
  return [...new Map(requirements.map((requirement) => [requirement.id, requirement])).values()];
}

function dedupeSuggestedEdits(
  suggestions: readonly OpensteerReverseSuggestedEdit[],
): readonly OpensteerReverseSuggestedEdit[] {
  return [...new Map(suggestions.map((suggestion) => [suggestion.id, suggestion])).values()];
}
