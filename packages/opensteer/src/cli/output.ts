import type { OpensteerSemanticOperationName } from "@opensteer/protocol";

export function renderOperationOutput(
  operation: OpensteerSemanticOperationName,
  result: unknown,
  input?: Record<string, unknown>,
): string {
  switch (operation) {
    case "session.open":
    case "page.goto":
      return renderJson(formatNavigationOutput(result));
    case "page.snapshot":
      return formatSnapshotOutput(result);
    case "dom.click":
    case "dom.hover":
    case "dom.input":
    case "dom.scroll":
      return renderJson(formatActionOutput(result, input));
    case "dom.extract":
      return renderJson(formatExtractOutput(result));
    case "page.list":
    case "page.new":
    case "page.activate":
    case "page.close":
      return formatTabOutput(result);
    case "network.query":
      return formatNetworkQueryOutput(result, input);
    case "network.detail":
      return formatNetworkDetailOutput(result);
    case "network.replay":
    case "session.fetch":
      return renderJson(formatTransportOutput(result, operation));
    case "session.cookies":
      return formatCookiesOutput(result);
    case "session.storage":
      return formatStorageOutput(result);
    case "session.state":
      return formatStateOutput(result);
    case "computer.execute":
      return renderJson(formatComputerOutput(result));
    case "scripts.capture":
      return formatScriptsCaptureOutput(result);
    case "scripts.beautify":
      return formatScriptTransformOutput(result, "scripts.beautify");
    case "scripts.deobfuscate":
      return formatScriptTransformOutput(result, "scripts.deobfuscate");
    case "scripts.sandbox":
      return renderJson(formatScriptSandboxOutput(result));
    case "captcha.solve":
      return renderJson(formatCaptchaSolveOutput(result));
    case "interaction.capture":
    case "interaction.get":
      return renderJson(formatInteractionTraceOutput(result));
    case "interaction.diff":
      return renderJson(formatInteractionDiffOutput(result));
    case "interaction.replay":
      return renderJson(formatInteractionReplayOutput(result));
    default:
      return renderJson(result);
  }
}

function formatNavigationOutput(result: unknown): Record<string, unknown> {
  return {
    ...(readStringField(result, "url") === undefined ? {} : { url: readStringField(result, "url") }),
    ...(readStringField(result, "title") === undefined ? {} : { title: readStringField(result, "title") }),
  };
}

function formatSnapshotOutput(result: unknown): string {
  if (
    result !== null &&
    typeof result === "object" &&
    typeof (result as { readonly html?: unknown }).html === "string"
  ) {
    return `${(result as { readonly html: string }).html}\n`;
  }
  return renderJson(result);
}

function formatActionOutput(
  result: unknown,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const target = readObjectField(result, "target");
  const output: Record<string, unknown> = {
    ...(readStringField(target, "tagName") === undefined ? {} : { tagName: readStringField(target, "tagName") }),
    ...(readStringField(target, "pathHint") === undefined ? {} : { pathHint: readStringField(target, "pathHint") }),
  };

  const point = readObjectField(result, "point");
  if (point !== undefined) {
    output.point = {
      ...(readNumberField(point, "x") === undefined ? {} : { x: readNumberField(point, "x") }),
      ...(readNumberField(point, "y") === undefined ? {} : { y: readNumberField(point, "y") }),
    };
  }

  const persisted =
    readStringField(result, "persisted");
  if (persisted !== undefined) {
    output.persisted = persisted;
  }

  const text = readStringField(input, "text");
  if (text !== undefined) {
    output.text = text;
  }

  const direction = readStringField(input, "direction");
  if (direction !== undefined) {
    output.direction = direction;
  }

  const amount = readNumberField(input, "amount");
  if (amount !== undefined) {
    output.amount = amount;
  }

  return output;
}

function formatExtractOutput(result: unknown): unknown {
  const data = readUnknownField(result, "data");
  return data === undefined ? result : data;
}

function formatTabOutput(result: unknown): string {
  const pages = readArrayField(result, "pages");
  const activePageRef = readStringField(result, "activePageRef");
  const lines = [`[tabs] ${pages.length} tab${pages.length === 1 ? "" : "s"}`];
  pages.forEach((page, index) => {
    const marker = readStringField(page, "pageRef") === activePageRef ? "*" : " ";
    lines.push(
      `${marker} ${String(index + 1).padStart(2, " ")}  ${truncateInline(readStringField(page, "title") ?? "(untitled)", 48)}  ${readStringField(page, "url") ?? ""}`,
    );
  });
  return `${lines.join("\n")}\n`;
}

function formatNetworkQueryOutput(
  result: unknown,
  input: Record<string, unknown> | undefined,
): string {
  const records = readArrayField(result, "records");
  const capture = summarizeCapture(records);
  const jsonOnly = readBooleanField(input, "json") === true;
  const lines = [
    `[network.query] ${records.length} record${records.length === 1 ? "" : "s"}${capture === undefined ? "" : ` from capture "${capture}"`}${jsonOnly ? " (JSON/GraphQL only)" : ""}`,
  ];
  for (const record of records) {
    const graphql = readObjectField(record, "graphql");
    const operationName = readStringField(graphql, "operationName");
    lines.push(
      `${readStringField(record, "recordId") ?? "rec:unknown"}  ${readStringField(record, "method") ?? "GET"} ${readStatus(record)}  ${readStringField(record, "resourceType") ?? "unknown"}  ${readStringField(record, "url") ?? ""}${operationName === undefined ? "" : `  [query: ${operationName}]`}`,
    );
    const request = readObjectField(record, "request");
    const response = readObjectField(record, "response");
    const websocket = readObjectField(record, "websocket");
    if (request !== undefined) {
      lines.push(`  request: ${formatBodySummary(request)}`);
    }
    if (response !== undefined) {
      lines.push(`  response: ${formatBodySummary(response)}`);
    }
    const subprotocol = readStringField(websocket, "subprotocol");
    if (subprotocol !== undefined) {
      lines.push(`  subprotocol: ${subprotocol}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatNetworkDetailOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return renderJson(result);
  }

  const lines = [`[network.detail] ${readStringField(result, "recordId") ?? "unknown"}`, ""];
  const summary = readObjectField(result, "summary");
  if (summary !== undefined) {
    lines.push(
      `${readStringField(summary, "method") ?? "GET"} ${readStatus(summary)} ${readStringField(summary, "url") ?? ""}`,
    );
  }

  const graphql = readObjectField(result, "graphql");
  if (graphql !== undefined) {
    const operationType = readStringField(graphql, "operationType");
    const operationName = readStringField(graphql, "operationName");
    lines.push(
      `${["GraphQL:", operationType, operationName].filter((value) => value !== undefined).join(" ")}`,
    );
    const variables = readUnknownField(graphql, "variables");
    if (variables !== undefined) {
      lines.push("Variables:");
      lines.push(indentLines(stringifyValue(variables)));
    }
  }

  const requestHeaders = readArrayField(result, "requestHeaders");
  if (requestHeaders.length > 0) {
    lines.push("", "Request headers:");
    lines.push(...requestHeaders.map((header) => formatHeaderLine(header)));
  }

  const responseHeaders = readArrayField(result, "responseHeaders");
  if (responseHeaders.length > 0) {
    lines.push("", "Response headers:");
    lines.push(...responseHeaders.map((header) => formatHeaderLine(header)));
  }

  const cookiesSent = readArrayField(result, "cookiesSent");
  if (cookiesSent.length > 0) {
    lines.push("", "Cookies sent:");
    lines.push(
      ...cookiesSent.map((cookie) => {
        const name = readStringField(cookie, "name") ?? "cookie";
        const value = readStringField(cookie, "value") ?? "";
        return `  ${name}: ${truncateInline(value, 80)}`;
      }),
    );
  }

  const requestBody = readObjectField(result, "requestBody");
  if (requestBody !== undefined) {
    lines.push("", formatBodyPreview("Request body", requestBody));
  }

  const responseBody = readObjectField(result, "responseBody");
  if (responseBody !== undefined) {
    lines.push("", formatBodyPreview("Response body", responseBody));
  }

  const redirectChain = readArrayField(result, "redirectChain");
  if (redirectChain.length > 0) {
    lines.push("", `Redirect chain (${redirectChain.length} hop${redirectChain.length === 1 ? "" : "s"}):`);
    redirectChain.forEach((hop, index) => {
      const location = readStringField(hop, "location");
      lines.push(
        `  ${index + 1}. ${readStringField(hop, "method") ?? "GET"} ${readStatus(hop)} ${readStringField(hop, "url") ?? ""}${location === undefined ? "" : `  ->  Location: ${location}`}`,
      );
    });
  }

  const notes = readArrayField(result, "notes")
    .map((entry) => (typeof entry === "string" ? entry : undefined))
    .filter((entry): entry is string => entry !== undefined);
  if (notes.length > 0) {
    lines.push("", ...notes.map((note) => `Note: ${note}`));
  }

  return `${lines.join("\n")}\n`;
}

function formatTransportOutput(
  result: unknown,
  operation: "network.replay" | "session.fetch",
): Record<string, unknown> {
  if (result === null || typeof result !== "object") {
    return { result };
  }

  const response = readObjectField(result, "response");
  const attempts = readArrayField(result, "attempts").map((attempt) => ({
    ...(readStringField(attempt, "transport") === undefined
      ? {}
      : { transport: readStringField(attempt, "transport") }),
    ...(readNumberField(attempt, "status") === undefined
      ? {}
      : { status: readNumberField(attempt, "status") }),
    ...(readStringField(attempt, "note") === undefined ? {} : { note: readStringField(attempt, "note") }),
    ...(readStringField(attempt, "error") === undefined ? {} : { error: readStringField(attempt, "error") }),
  }));
  const contentType =
    response === undefined
      ? undefined
      : findHeaderValue(readArrayField(response, "headers"), "content-type") ??
        readStringField(readObjectField(response, "body"), "mimeType");
  const body = readObjectField(response, "body");
  const bodySize =
    body === undefined
      ? undefined
      : readNumberField(body, "originalByteLength") ?? readNumberField(body, "capturedByteLength");
  const output: Record<string, unknown> = {
    ...(operation === "network.replay" && readStringField(result, "recordId") !== undefined
      ? { recordId: readStringField(result, "recordId") }
      : {}),
    ...(readStringField(result, "transport") === undefined
      ? {}
      : { transport: readStringField(result, "transport") }),
    ...(response === undefined ? {} : { status: readNumberField(response, "status") }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(bodySize === undefined ? {} : { bodySize }),
  };

  const note = readStringField(result, "note");
  if (note !== undefined) {
    output.note = note;
  }

  const data = readUnknownField(result, "data");
  if (data !== undefined) {
    output.data = truncateDataShape(data);
  }

  if (attempts.length > 0) {
    output.attempts = attempts;
  }

  if (JSON.stringify(output).length > 4_096 && data !== undefined) {
    output.data = `... truncated, ${JSON.stringify(data).length.toLocaleString("en-US")} chars total`;
  }

  return output;
}

function formatCookiesOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return renderJson(result);
  }
  const cookies = readArrayField(result, "cookies");
  const domain = readStringField(result, "domain");
  const lines = [`[cookies] ${cookies.length} cookie${cookies.length === 1 ? "" : "s"}${domain === undefined ? "" : ` for ${domain}`}`];
  for (const cookie of cookies) {
    const flags = [
      readBooleanField(cookie, "session") === true ? "session" : undefined,
      readBooleanField(cookie, "httpOnly") === true ? "httpOnly" : undefined,
      readBooleanField(cookie, "secure") === true ? "secure" : undefined,
      readStringField(cookie, "expiresAt"),
    ].filter((value) => value !== undefined);
    lines.push(
      `  ${padRight(readStringField(cookie, "name") ?? "cookie", 20)} ${truncateInline(readStringField(cookie, "value") ?? "", 48)}${flags.length === 0 ? "" : `  ${flags.join("  ")}`}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatStorageOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return renderJson(result);
  }
  const domains = readArrayField(result, "domains");
  const lines: string[] = [];
  for (const domain of domains) {
    const domainName = readStringField(domain, "domain") ?? "unknown";
    const localStorage = readArrayField(domain, "localStorage");
    const sessionStorage = readArrayField(domain, "sessionStorage");
    lines.push(`[storage] localStorage for ${domainName} (${localStorage.length} key${localStorage.length === 1 ? "" : "s"})`, "");
    lines.push(...localStorage.map((entry) => formatStorageEntry(entry)));
    lines.push("", `[storage] sessionStorage for ${domainName} (${sessionStorage.length} key${sessionStorage.length === 1 ? "" : "s"})`, "");
    lines.push(...sessionStorage.map((entry) => formatStorageEntry(entry)), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatStateOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return renderJson(result);
  }
  const domains = readArrayField(result, "domains");
  const lines: string[] = [];
  for (const domain of domains) {
    const name = readStringField(domain, "domain") ?? "unknown";
    lines.push(`[state] ${name}`, "");
    const cookies = readArrayField(domain, "cookies");
    lines.push(`Cookies (${cookies.length}):`);
    lines.push(
      ...cookies.map(
        (cookie) =>
          `  ${padRight(readStringField(cookie, "name") ?? "cookie", 16)} ${truncateInline(readStringField(cookie, "value") ?? "", 36)}`,
      ),
    );
    const hiddenFields = readArrayField(domain, "hiddenFields");
    lines.push("", `Hidden fields (${hiddenFields.length}):`);
    lines.push(
      ...hiddenFields.map(
        (field) =>
          `  ${readStringField(field, "path") ?? "input"}  = ${JSON.stringify(readStringField(field, "value") ?? "")}`,
      ),
    );
    const localStorage = readArrayField(domain, "localStorage");
    lines.push("", `localStorage (${localStorage.length} key${localStorage.length === 1 ? "" : "s"}):`);
    lines.push(...localStorage.map((entry) => formatStorageEntry(entry)));
    const sessionStorage = readArrayField(domain, "sessionStorage");
    lines.push("", `sessionStorage (${sessionStorage.length} key${sessionStorage.length === 1 ? "" : "s"}):`);
    lines.push(...sessionStorage.map((entry) => formatStorageEntry(entry)));
    const globals = readObjectField(domain, "globals");
    if (globals !== undefined) {
      lines.push("", "Globals:");
      for (const [key, value] of Object.entries(globals)) {
        lines.push(`  ${key} = ${truncateInline(stringifyScalarLike(value), 80)}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatComputerOutput(result: unknown): Record<string, unknown> {
  const action = readObjectField(result, "action");
  const screenshot = readObjectField(result, "screenshot");
  const payload = readObjectField(screenshot, "payload");
  const timing = readObjectField(result, "timing");
  return {
    ...(action === undefined ? {} : { action }),
    ...(payload === undefined
      ? {}
      : {
          screenshot: {
            ...(readStringField(payload, "uri") === undefined ? {} : { uri: readStringField(payload, "uri") }),
            ...(readStringField(screenshot, "format") === undefined ? {} : { format: readStringField(screenshot, "format") }),
            ...(readObjectField(screenshot, "size") === undefined ? {} : { size: readObjectField(screenshot, "size") }),
          },
        }),
    ...(timing === undefined ? {} : { timingMs: timing }),
  };
}

function formatScriptsCaptureOutput(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return renderJson(result);
  }
  const scripts = readArrayField(result, "scripts");
  const lines = [`[scripts.capture] ${scripts.length} script${scripts.length === 1 ? "" : "s"}`];
  for (const script of scripts) {
    const source = readStringField(script, "source") ?? "unknown";
    const url = readStringField(script, "url") ?? "<inline>";
    const artifactId = readStringField(script, "artifactId");
    const content = readStringField(script, "content") ?? "";
    lines.push(
      `${artifactId === undefined ? "-" : artifactId}  ${source.padEnd(8, " ")}  ${truncateInline(url, 120)}  (${content.length.toLocaleString("en-US")} chars)`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatScriptTransformOutput(
  result: unknown,
  label: "scripts.beautify" | "scripts.deobfuscate",
): string {
  if (result === null || typeof result !== "object") {
    return renderJson(result);
  }
  const lines = [
    `[${label}] ${formatBytes(readNumberField(result, "bytesBefore"))} -> ${formatBytes(readNumberField(result, "bytesAfter"))}`,
  ];
  const artifactId = readStringField(result, "artifactId");
  if (artifactId !== undefined) {
    lines.push(`artifact: ${artifactId}`);
  }
  const transforms = readArrayField(result, "transforms")
    .map((value) => (typeof value === "string" ? value : undefined))
    .filter((value): value is string => value !== undefined);
  if (transforms.length > 0) {
    lines.push(`transforms: ${transforms.join(", ")}`);
  }
  const content = readStringField(result, "content");
  if (content !== undefined) {
    lines.push("", content);
  }
  return `${lines.join("\n")}\n`;
}

function formatInteractionTraceOutput(result: unknown): Record<string, unknown> {
  const trace = readObjectField(result, "trace");
  if (trace === undefined) {
    return { result };
  }
  const payload = readObjectField(trace, "payload");
  return {
    ...(readStringField(trace, "id") === undefined ? {} : { id: readStringField(trace, "id") }),
    ...(readStringField(trace, "key") === undefined ? {} : { key: readStringField(trace, "key") }),
    ...(readStringField(trace, "version") === undefined
      ? {}
      : { version: readStringField(trace, "version") }),
    ...(readStringField(payload, "mode") === undefined ? {} : { mode: readStringField(payload, "mode") }),
    ...(readStringField(payload, "url") === undefined ? {} : { url: readStringField(payload, "url") }),
    ...(readArrayField(payload, "events").length === 0
      ? {}
      : { eventCount: readArrayField(payload, "events").length }),
    ...(readArrayField(payload, "networkRecordIds").length === 0
      ? {}
      : { networkRecordIds: readArrayField(payload, "networkRecordIds") }),
  };
}

function formatScriptSandboxOutput(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== "object") {
    return { result };
  }

  const capturedAjax = readArrayField(result, "capturedAjax").map((entry) => ({
    ...(readStringField(entry, "method") === undefined
      ? {}
      : { method: readStringField(entry, "method") }),
    ...(readStringField(entry, "url") === undefined ? {} : { url: readStringField(entry, "url") }),
    ...(readNumberField(entry, "timestamp") === undefined
      ? {}
      : { timestamp: readNumberField(entry, "timestamp") }),
  }));
  const errors = readArrayField(result, "errors")
    .map((entry) => (typeof entry === "string" ? entry : undefined))
    .filter((entry): entry is string => entry !== undefined);

  return {
    ...(readNumberField(result, "durationMs") === undefined
      ? {}
      : { durationMs: readNumberField(result, "durationMs") }),
    ...(capturedAjax.length === 0 ? {} : { capturedAjax }),
    ...(errors.length === 0 ? {} : { errors }),
    ...(readUnknownField(result, "result") === undefined
      ? {}
      : { result: truncateDataShape(readUnknownField(result, "result")) }),
  };
}

function formatCaptchaSolveOutput(result: unknown): Record<string, unknown> {
  const captcha = readObjectField(result, "captcha");
  return {
    ...(readStringField(result, "provider") === undefined
      ? {}
      : { provider: readStringField(result, "provider") }),
    ...(captcha === undefined
      ? {}
      : {
          captcha: {
            ...(readStringField(captcha, "type") === undefined
              ? {}
              : { type: readStringField(captcha, "type") }),
            ...(readStringField(captcha, "siteKey") === undefined
              ? {}
              : { siteKey: readStringField(captcha, "siteKey") }),
            ...(readStringField(captcha, "pageUrl") === undefined
              ? {}
              : { pageUrl: readStringField(captcha, "pageUrl") }),
          },
        }),
    ...(readStringField(result, "token") === undefined ? {} : { token: readStringField(result, "token") }),
    ...(readBooleanField(result, "injected") === undefined
      ? {}
      : { injected: readBooleanField(result, "injected") }),
  };
}

function formatInteractionDiffOutput(result: unknown): Record<string, unknown> {
  return {
    ...(readObjectField(result, "summary") === undefined
      ? {}
      : { summary: readObjectField(result, "summary") }),
    ...(readArrayField(result, "eventSequenceMismatches").length === 0
      ? {}
      : { eventSequenceMismatches: readArrayField(result, "eventSequenceMismatches") }),
    ...(readArrayField(result, "eventPropertyMismatches").length === 0
      ? {}
      : { eventPropertyMismatches: readArrayField(result, "eventPropertyMismatches") }),
    ...(readArrayField(result, "stateMismatches").length === 0
      ? {}
      : { stateMismatches: readArrayField(result, "stateMismatches") }),
    ...(readArrayField(result, "downstreamRequestMismatches").length === 0
      ? {}
      : { downstreamRequestMismatches: readArrayField(result, "downstreamRequestMismatches") }),
  };
}

function formatInteractionReplayOutput(result: unknown): Record<string, unknown> {
  return {
    ...(readStringField(result, "traceId") === undefined ? {} : { traceId: readStringField(result, "traceId") }),
    ...(readNumberField(result, "replayedEventCount") === undefined
      ? {}
      : { replayedEventCount: readNumberField(result, "replayedEventCount") }),
    ...(readBooleanField(result, "success") === undefined
      ? {}
      : { success: readBooleanField(result, "success") }),
    ...(readStringField(result, "error") === undefined ? {} : { error: readStringField(result, "error") }),
  };
}

function formatBodySummary(body: unknown): string {
  if (body === null || typeof body !== "object") {
    return "unknown";
  }
  if (readBooleanField(body, "streaming") === true) {
    return `streaming (${readStringField(body, "contentType") ?? "unknown"})`;
  }
  return `${formatBytes(readNumberField(body, "bytes"))} (${readStringField(body, "contentType") ?? "unknown"})`;
}

function formatBodyPreview(label: string, preview: unknown): string {
  const header = `${label} (${formatBytes(readNumberField(preview, "bytes"))}${readStringField(preview, "contentType") === undefined ? "" : `, ${readStringField(preview, "contentType")}`}${readBooleanField(preview, "truncated") === true ? ", truncated" : ""}):`;
  const data = readUnknownField(preview, "data");
  if (data === undefined) {
    return header;
  }
  return `${header}\n${indentLines(stringifyValue(data))}`;
}

function formatStorageEntry(entry: unknown): string {
  return `  ${padRight(readStringField(entry, "key") ?? "key", 18)} ${truncateInline(readStringField(entry, "value") ?? "", 80)}`;
}

function formatHeaderLine(header: unknown): string {
  return `  ${readStringField(header, "name") ?? "header"}: ${readStringField(header, "value") ?? ""}`;
}

function truncateDataShape(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= 200 ? value : `${value.slice(0, 200)}...${value.length} chars total`;
  }
  if (Array.isArray(value)) {
    if (depth >= 4) {
      return `... ${value.length} items`;
    }
    if (value.length > 3) {
      return [
        `... ${value.length} items, first 2 shown`,
        truncateDataShape(value[0], depth + 1),
        truncateDataShape(value[1], depth + 1),
      ];
    }
    return value.map((entry) => truncateDataShape(entry, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= 4) {
      return `... ${entries.length} keys`;
    }
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, truncateDataShape(entry, depth + 1)]),
    );
  }
  return String(value);
}

function readArrayField(value: unknown, key: string): readonly unknown[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

function readObjectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return field !== null && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function readUnknownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readStringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function readNumberField(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : undefined;
}

function readStatus(value: unknown): string {
  const status = readNumberField(value, "status");
  return status === undefined ? "-" : String(status);
}

function findHeaderValue(headers: readonly unknown[], name: string): string | undefined {
  const normalized = name.toLowerCase();
  for (const header of headers) {
    if (readStringField(header, "name")?.toLowerCase() === normalized) {
      return readStringField(header, "value");
    }
  }
  return undefined;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "unknown";
  }
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function summarizeCapture(records: readonly unknown[]): string | undefined {
  const captures = new Set(
    records
      .map((record) => readStringField(record, "capture"))
      .filter((capture): capture is string => capture !== undefined),
  );
  return captures.size === 1 ? [...captures][0] : undefined;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function truncateInline(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 18))}...${value.length} chars`;
}

function stringifyValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function stringifyScalarLike(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function indentLines(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
