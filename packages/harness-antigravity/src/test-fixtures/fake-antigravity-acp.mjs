import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "unrelated";
const sessionId = "11111111-1111-4111-8111-111111111111";

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function update(value) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
}

function failureTranscript(httpStatus, message, grpcStatus) {
  return [
    `I harness stderr: received model response error: Error ${httpStatus}, Message: ${message}, Status: ${grpcStatus}, Details: []`,
    `W System step error (HTTP ${httpStatus}): Agent execution terminated due to error.`,
    `E Antigravity SDK error processing prompt for session ${sessionId}`,
  ].join("\n");
}

function prompt(id) {
  if (scenario === "unrelated") {
    process.stderr.write("ERROR cache cleanup was skipped\n");
    update({
      content: { text: "READY", type: "text" },
      sessionUpdate: "agent_message_chunk",
    });
    send({ id, jsonrpc: "2.0", result: { stopReason: "end_turn" } });
    return;
  }

  const failure =
    scenario === "unauthorized"
      ? { grpcStatus: "UNAUTHENTICATED", httpStatus: 401, message: "The API key is invalid" }
      : scenario === "rate-limit"
        ? {
            grpcStatus: "RESOURCE_EXHAUSTED",
            httpStatus: 429,
            message: "Rate limit reached; resets at 2026-11-01T18:00:00Z",
          }
        : scenario === "generic"
          ? {
              grpcStatus: "INTERNAL",
              httpStatus: 500,
              message: `Provider exploded: ${process.env.GEMINI_API_KEY}`,
            }
          : {
              grpcStatus: "RESOURCE_EXHAUSTED",
              httpStatus: 402,
              message: "Your prepayment credits are depleted.",
            };
  const stderr = `${failureTranscript(failure.httpStatus, failure.message, failure.grpcStatus)}\n`;
  const emitErrorChunk = () => {
    update({
      content: { text: failure.message, type: "text" },
      sessionUpdate: "agent_message_chunk",
    });
  };
  const emitResult = () => {
    send({ id, jsonrpc: "2.0", result: { stopReason: "end_turn" } });
  };
  if (scenario === "credits-stderr-first") {
    process.stderr.write(stderr);
    emitErrorChunk();
    emitResult();
  } else {
    emitErrorChunk();
    process.stderr.write(stderr);
    emitResult();
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      send({
        id: request.id,
        jsonrpc: "2.0",
        result: { agentCapabilities: {}, authMethods: [], protocolVersion: 1 },
      });
      return;
    case "session/new":
      send({ id: request.id, jsonrpc: "2.0", result: { sessionId } });
      return;
    case "session/set_model":
    case "session/close":
      send({ id: request.id, jsonrpc: "2.0", result: {} });
      return;
    case "session/prompt":
      prompt(request.id);
      return;
    default:
      send({
        error: { code: -32601, message: `Unsupported method ${request.method}` },
        id: request.id,
        jsonrpc: "2.0",
      });
  }
});
