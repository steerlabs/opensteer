import {
  OpensteerProtocolError,
  opensteerRequestPlanPayloadSchema,
  validateJsonSchema,
  type OpensteerRequestPlanParameter,
  type OpensteerRequestPlanPayload,
} from "@opensteer/protocol";

const HTTP_METHOD_PATTERN = /^[A-Za-z]+$/;
const URL_TEMPLATE_PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_-]*)\}/g;

export function assertValidRequestPlanPayload(payload: unknown): asserts payload is OpensteerRequestPlanPayload {
  const issues = validateJsonSchema(opensteerRequestPlanPayloadSchema, payload);
  if (issues.length === 0) {
    return;
  }

  const firstIssue = issues[0]!;
  throw new OpensteerProtocolError(
    "invalid-request",
    `invalid request plan payload at ${firstIssue.path}: ${firstIssue.message}`,
    {
      details: {
        issues,
      },
    },
  );
}

export function normalizeRequestPlanPayload(
  payload: OpensteerRequestPlanPayload,
): OpensteerRequestPlanPayload {
  assertValidRequestPlanPayload(payload);

  const method = payload.endpoint.method.trim().toUpperCase();
  if (!HTTP_METHOD_PATTERN.test(method)) {
    throw new Error(`request plan endpoint.method must be an HTTP method, received ${payload.endpoint.method}`);
  }

  const urlTemplate = payload.endpoint.urlTemplate.trim();
  if (urlTemplate.length === 0) {
    throw new Error("request plan endpoint.urlTemplate must be a non-empty string");
  }

  const placeholders = extractUrlTemplatePlaceholders(urlTemplate);
  assertAbsoluteUrlTemplate(urlTemplate, placeholders);

  const normalizedParameters = normalizeParameters(payload.parameters ?? []);
  const pathParameters = normalizedParameters.filter((parameter) => parameter.in === "path");
  const pathParameterNames = new Set(pathParameters.map((parameter) => parameter.name));
  if (placeholders.length !== pathParameterNames.size) {
    throw new Error(
      `request plan path parameters must exactly match urlTemplate placeholders: ${placeholders.join(", ")}`,
    );
  }
  for (const placeholder of placeholders) {
    if (!pathParameterNames.has(placeholder)) {
      throw new Error(`request plan urlTemplate placeholder {${placeholder}} is missing a path parameter`);
    }
  }
  for (const parameter of pathParameters) {
    if (!placeholders.includes(parameter.name)) {
      throw new Error(`request plan path parameter ${parameter.name} is not present in the urlTemplate`);
    }
  }

  const transport = normalizeTransport(payload.transport);
  const endpoint = {
    method,
    urlTemplate,
    ...(payload.endpoint.defaultQuery === undefined || payload.endpoint.defaultQuery.length === 0
      ? {}
      : {
          defaultQuery: payload.endpoint.defaultQuery.map((entry) => ({
            name: entry.name.trim(),
            value: entry.value,
          })),
        }),
    ...(payload.endpoint.defaultHeaders === undefined || payload.endpoint.defaultHeaders.length === 0
      ? {}
      : {
          defaultHeaders: payload.endpoint.defaultHeaders.map((entry) => ({
            name: entry.name.trim(),
            value: entry.value,
          })),
        }),
  } satisfies OpensteerRequestPlanPayload["endpoint"];

  return {
    transport,
    endpoint,
    ...(normalizedParameters.length === 0 ? {} : { parameters: normalizedParameters }),
    ...(payload.body === undefined
      ? {}
      : {
          body: {
            ...(payload.body.contentType === undefined
              ? {}
              : { contentType: payload.body.contentType.trim() }),
            ...(payload.body.required === undefined ? {} : { required: payload.body.required }),
            ...(payload.body.description === undefined
              ? {}
              : { description: payload.body.description.trim() }),
          },
        }),
    ...(payload.response === undefined
      ? {}
      : {
          response: {
            status: payload.response.status,
            ...(payload.response.contentType === undefined
              ? {}
              : { contentType: payload.response.contentType.trim().toLowerCase() }),
          },
        }),
    ...(payload.auth === undefined
      ? {}
      : {
          auth: {
            strategy: payload.auth.strategy,
            ...(payload.auth.recipeRef === undefined
              ? {}
              : { recipeRef: payload.auth.recipeRef.trim() }),
            ...(payload.auth.description === undefined
              ? {}
              : { description: payload.auth.description.trim() }),
          },
        }),
  };
}

export function extractUrlTemplatePlaceholders(urlTemplate: string): readonly string[] {
  const placeholders: string[] = [];
  for (const match of urlTemplate.matchAll(URL_TEMPLATE_PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !placeholders.includes(name)) {
      placeholders.push(name);
    }
  }
  return placeholders;
}

function normalizeParameters(
  parameters: readonly OpensteerRequestPlanParameter[],
): OpensteerRequestPlanParameter[] {
  const seenByLocation = new Set<string>();

  return parameters.map((parameter) => {
    const name = parameter.name.trim();
    if (name.length === 0) {
      throw new Error("request plan parameter.name must be a non-empty string");
    }

    const seenKey = `${parameter.in}:${name}`;
    if (seenByLocation.has(seenKey)) {
      throw new Error(`duplicate request plan parameter ${name} in ${parameter.in}`);
    }
    seenByLocation.add(seenKey);

    if (parameter.in === "path") {
      if (parameter.wireName !== undefined && parameter.wireName.trim() !== name) {
        throw new Error(`path parameter ${name} cannot define a wireName different from its placeholder`);
      }
      if (parameter.defaultValue !== undefined) {
        throw new Error(`path parameter ${name} cannot define a defaultValue`);
      }
      if (parameter.required === false) {
        throw new Error(`path parameter ${name} cannot be optional`);
      }
      return {
        name,
        in: "path",
        required: true,
        ...(parameter.description === undefined
          ? {}
          : { description: parameter.description.trim() }),
      };
    }

    return {
      name,
      in: parameter.in,
      ...(parameter.wireName === undefined ? {} : { wireName: parameter.wireName.trim() }),
      ...(parameter.required === undefined ? {} : { required: parameter.required }),
      ...(parameter.description === undefined
        ? {}
        : { description: parameter.description.trim() }),
      ...(parameter.defaultValue === undefined ? {} : { defaultValue: parameter.defaultValue }),
    };
  });
}

function normalizeTransport(
  transport: OpensteerRequestPlanPayload["transport"],
): OpensteerRequestPlanPayload["transport"] {
  switch (transport.kind) {
    case "session-http":
      if (transport.requiresBrowser === false) {
        throw new Error("session-http transport always requiresBrowser");
      }
      return {
        kind: "session-http",
        requiresBrowser: true,
      };
    case "direct-http":
      return {
        kind: "direct-http",
        ...(transport.requiresBrowser === undefined
          ? { requiresBrowser: false }
          : { requiresBrowser: transport.requiresBrowser }),
      };
  }
}

function assertAbsoluteUrlTemplate(
  urlTemplate: string,
  placeholders: readonly string[],
): void {
  const sampleUrl = placeholders.reduce(
    (current, placeholder) => current.replaceAll(`{${placeholder}}`, "placeholder"),
    urlTemplate,
  );

  try {
    // eslint-disable-next-line no-new
    new URL(sampleUrl);
  } catch {
    throw new Error(`request plan endpoint.urlTemplate must be an absolute URL, received ${urlTemplate}`);
  }
}
