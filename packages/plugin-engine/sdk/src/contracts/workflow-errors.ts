/** Failure markers survive the native workflow engine's error serialization. */
import { Schema, Option } from "effect";
import { WorkflowFailure, WorkflowRunFailure } from "apps/contracts";

const DetailJson = Schema.fromJsonString(WorkflowRunFailure);
const marker = /PluginEngineWorkflowFailure\(([a-z_]+),(true|false)\)(?: (\{[\s\S]*\}))?/;

/** The failing step and app error a failure carries, if any. */
export const workflowFailureDetail = ({
  step,
  errorName,
  message,
}: WorkflowFailure): WorkflowRunFailure | undefined =>
  step === undefined && errorName === undefined && message.length === 0
    ? undefined
    : {
        ...(step === undefined ? {} : { step }),
        ...(errorName === undefined ? {} : { errorName }),
        ...(message.length === 0 ? {} : { message }),
      };

/**
 * Encode the reason, retry flag and the app's bounded, secret-free error detail. The native engine
 * keeps only an error message, so the detail travels as JSON after the marker.
 */
export const workflowFailureMessage = (failure: WorkflowFailure) => {
  const detail = workflowFailureDetail(failure);
  return `PluginEngineWorkflowFailure(${failure.reason},${failure.retryable})${
    detail === undefined ? "" : ` ${Schema.encodeSync(DetailJson)(detail)}`
  }`;
};
/** Native engines can wrap exception names; recover only our validated marker and detail. */
export const decodeWorkflowFailure = (error: unknown): WorkflowFailure => {
  if (Schema.is(WorkflowFailure)(error)) return error;
  const message = error instanceof Error ? error.message : "";
  const match = marker.exec(message);
  if (match !== null) {
    const parsed = Schema.decodeUnknownOption(WorkflowFailure.fields.reason)(match[1]);
    if (Option.isSome(parsed)) {
      const detail =
        match[3] === undefined ? Option.none() : Schema.decodeUnknownOption(DetailJson)(match[3]);
      return new WorkflowFailure({
        reason: parsed.value,
        retryable: match[2] === "true",
        ...Option.getOrElse(detail, () => ({})),
      });
    }
  }
  return new WorkflowFailure({ reason: "engine", retryable: true });
};
