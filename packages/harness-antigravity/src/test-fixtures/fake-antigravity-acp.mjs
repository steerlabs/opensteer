import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "unrelated";
const sessionId = "11111111-1111-4111-8111-111111111111";
const foreignSessionId = "22222222-2222-4222-8222-222222222222";
let promptCount = 0;

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

function failureTranscript(httpStatus, message, grpcStatus, owner = sessionId) {
  return [
    `I harness stderr: received model response error: Error ${httpStatus}, Message: ${message}, Status: ${grpcStatus}, Details: []`,
    `I harness stderr: Agent run failed: executor run failed: Error ${httpStatus}, Message: ${message}, Status: ${grpcStatus}, Details: []`,
    `W System step error (HTTP ${httpStatus}): Agent execution terminated due to error.`,
    `E Antigravity SDK error processing prompt for session ${owner}`,
  ].join("\n");
}

function prompt(id) {
  promptCount += 1;
  const emitChunk = (text) =>
    update({
      content: { text, type: "text" },
      sessionUpdate: "agent_message_chunk",
    });
  const emitResult = () => {
    send({ id, jsonrpc: "2.0", result: { stopReason: "end_turn" } });
  };

  if (scenario === "success-order") {
    emitChunk("The error");
    emitChunk(" is fixed.");
    emitResult();
    return;
  }
  if (scenario === "thought-first") {
    update({
      content: { text: "Considering the answer", type: "text" },
      sessionUpdate: "agent_thought_chunk",
    });
    emitChunk("READY");
    emitResult();
    return;
  }
  if (scenario === "long-reply") {
    emitChunk("a".repeat(1_024));
    emitChunk("b".repeat(1_025));
    emitResult();
    return;
  }
  if (scenario === "foreign-session") {
    process.stderr.write(
      `${failureTranscript(402, "FOREIGN SAFE", "RESOURCE_EXHAUSTED", foreignSessionId)}\n`,
    );
    emitChunk("FOREIGN SAFE");
    emitResult();
    return;
  }
  if (scenario === "late-block") {
    if (promptCount === 1) {
      update({
        content: { text: "Earlier reasoning", type: "text" },
        sessionUpdate: "agent_thought_chunk",
      });
      emitChunk("FIRST");
    } else {
      process.stderr.write(`${failureTranscript(500, "old failure", "INTERNAL")}\n`);
      emitChunk("SECOND");
    }
    emitResult();
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
        : scenario === "redaction"
          ? {
              grpcStatus: "INTERNAL",
              httpStatus: 500,
              message: "API key=AIza012345678901234567890123456789",
            }
          : {
              grpcStatus: "RESOURCE_EXHAUSTED",
              httpStatus: 402,
              message: "Your prepayment credits are depleted.",
            };
  const stderr = `${failureTranscript(failure.httpStatus, failure.message, failure.grpcStatus)}\n`;
  if (scenario === "credits-stderr-first") {
    process.stderr.write(stderr);
    emitChunk(failure.message);
    emitResult();
  } else if (scenario === "credits-stdout-first") {
    emitChunk(failure.message);
    emitResult();
    setImmediate(() => process.stderr.write(stderr));
  } else if (scenario === "credits-split") {
    emitChunk("Your prepayment credits ");
    emitChunk("are depleted.");
    process.stderr.write(stderr);
    emitResult();
  } else {
    emitChunk(failure.message);
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
