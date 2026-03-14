import {
  OpensteerProtocolError,
  opensteerRequestPlanPayloadSchema,
  validateJsonSchema,
  type OpensteerRequestPlanParameter,
  type OpensteerRequestEntry,
  type OpensteerRequestPlanPayload,
} from "@opensteer/protocol";

import { invalidRequestPlanError } from "../errors.js";

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
    throw invalidRequestPlanError(
      `request plan endpoint.method must be an HTTP method, received ${payload.endpoint.method}`,
      {
        field: "endpoint.method",
        value: payload.endpoint.method,
      },
    );
  }

  const urlTemplate = payload.endpoint.urlTemplate.trim();
  if (urlTemplate.length === 0) {
    throw invalidRequestPlanError("request plan endpoint.urlTemplate must be a non-empty string", {
      field: "endpoint.urlTemplate",
    });
  }

  const placeholders = extractUrlTemplatePlaceholders(urlTemplate);
  assertAbsoluteUrlTemplate(urlTemplate, placeholders);

  const normalizedParameters = normalizeParameters(payload.parameters ?? []);
  const pathParameters = normalizedParameters.filter((parameter) => parameter.in === "path");
  const pathParameterNames = new Set(pathParameters.map((parameter) => parameter.name));
  if (placeholders.length !== pathParameterNames.size) {
    throw invalidRequestPlanError(
      `request plan path parameters must exactly match urlTemplate placeholders: ${placeholders.join(", ")}`,
      {
        field: "parameters",
        placeholders,
      },
    );
  }
  for (const placeholder of placeholders) {
    if (!pathParameterNames.has(placeholder)) {
      throw invalidRequestPlanError(
        `request plan urlTemplate placeholder {${placeholder}} is missing a path parameter`,
        {
          field: "parameters",
          placeholder,
        },
      );
    }
  }
  for (const parameter of pathParameters) {
    if (!placeholders.includes(parameter.name)) {
      throw invalidRequestPlanError(
        `request plan path parameter ${parameter.name} is not present in the urlTemplate`,
        {
          field: "parameters",
          parameter: parameter.name,
        },
      );
    }
  }

  const transport = normalizeTransport(payload.transport);
  const endpoint = {
    method,
    urlTemplate,
    ...(payload.endpoint.defaultQuery === undefined || payload.endpoint.defaultQuery.length === 0
      ? {}
      : {
          defaultQuery: payload.endpoint.defaultQuery.map((entry, index) =>
            normalizeRequestEntry(entry, `endpoint.defaultQuery[${index}]`),
          ),
        }),
    ...(payload.endpoint.defaultHeaders === undefined || payload.endpoint.defaultHeaders.length === 0
      ? {}
      : {
          defaultHeaders: payload.endpoint.defaultHeaders.map((entry, index) =>
            normalizeRequestEntry(entry, `endpoint.defaultHeaders[${index}]`),
          ),
        }),
  } satisfies OpensteerRequestPlanPayload["endpoint"];

  const normalizedPayload = {
    transport,
    endpoint,
    ...(normalizedParameters.length === 0 ? {} : { parameters: normalizedParameters }),
    ...(payload.body === undefined
      ? {}
      : {
          body: {
            ...(payload.body.contentType === undefined
              ? {}
              : {
                  contentType: normalizeTrimmedString(
                    "body.contentType",
                    payload.body.contentType,
                  ),
                }),
            ...(payload.body.required === undefined ? {} : { required: payload.body.required }),
            ...(payload.body.description === undefined
              ? {}
              : {
                  description: normalizeTrimmedString(
                    "body.description",
                    payload.body.description,
                  ),
                }),
          },
        }),
    ...(payload.response === undefined
      ? {}
      : {
          response: {
            status: payload.response.status,
            ...(payload.response.contentType === undefined
              ? {}
              : {
                  contentType: normalizeTrimmedString(
                    "response.contentType",
                    payload.response.contentType,
                  ).toLowerCase(),
                }),
          },
        }),
    ...(payload.auth === undefined
      ? {}
      : {
          auth: {
            strategy: payload.auth.strategy,
            ...(payload.auth.recipeRef === undefined
              ? {}
              : {
                  recipeRef: normalizeTrimmedString(
                    "auth.recipeRef",
                    payload.auth.recipeRef,
                  ),
                }),
            ...(payload.auth.description === undefined
              ? {}
              : {
                  description: normalizeTrimmedString(
                    "auth.description",
                    payload.auth.description,
                  ),
                }),
          },
        }),
  } satisfies OpensteerRequestPlanPayload;

  assertValidRequestPlanPayload(normalizedPayload);
  return normalizedPayload;
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
    const name = normalizeTrimmedString("parameter.name", parameter.name);

    const seenKey = `${parameter.in}:${name}`;
    if (seenByLocation.has(seenKey)) {
      throw invalidRequestPlanError(`duplicate request plan parameter ${name} in ${parameter.in}`, {
        field: "parameters",
        parameter: name,
        location: parameter.in,
      });
    }
    seenByLocation.add(seenKey);

    if (parameter.in === "path") {
      if (parameter.wireName !== undefined) {
        const wireName = normalizeTrimmedString("parameter.wireName", parameter.wireName);
        if (wireName !== name) {
          throw invalidRequestPlanError(
            `path parameter ${name} cannot define a wireName different from its placeholder`,
            {
              field: "parameters",
              parameter: name,
              wireName,
            },
          );
        }
      }
      if (parameter.defaultValue !== undefined) {
        throw invalidRequestPlanError(`path parameter ${name} cannot define a defaultValue`, {
          field: "parameters",
          parameter: name,
        });
      }
      if (parameter.required === false) {
        throw invalidRequestPlanError(`path parameter ${name} cannot be optional`, {
          field: "parameters",
          parameter: name,
        });
      }
      return {
        name,
        in: "path",
        required: true,
        ...(parameter.description === undefined
          ? {}
          : {
              description: normalizeTrimmedString(
                "parameter.description",
                parameter.description,
              ),
            }),
      };
    }

    return {
      name,
      in: parameter.in,
      ...(parameter.wireName === undefined
        ? {}
        : { wireName: normalizeTrimmedString("parameter.wireName", parameter.wireName) }),
      ...(parameter.required === undefined ? {} : { required: parameter.required }),
      ...(parameter.description === undefined
        ? {}
        : {
            description: normalizeTrimmedString(
              "parameter.description",
              parameter.description,
            ),
          }),
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
        throw invalidRequestPlanError("session-http transport always requiresBrowser", {
          field: "transport.requiresBrowser",
          transport: transport.kind,
        });
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

  if (!URL.canParse(sampleUrl)) {
    throw invalidRequestPlanError(
      `request plan endpoint.urlTemplate must be an absolute URL, received ${urlTemplate}`,
      {
        field: "endpoint.urlTemplate",
        value: urlTemplate,
      },
    );
  }
}

function normalizeRequestEntry(
  entry: OpensteerRequestEntry,
  fieldPath: string,
): OpensteerRequestEntry {
  return {
    name: normalizeTrimmedString(`${fieldPath}.name`, entry.name),
    value: entry.value,
  };
}

function normalizeTrimmedString(field: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw invalidRequestPlanError(`${field} must be a non-empty string`, {
      field,
    });
  }
  return normalized;
}
