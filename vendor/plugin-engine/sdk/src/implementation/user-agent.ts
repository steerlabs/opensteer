import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * The User-Agent PluginEngine sends when a request names none. Workers send no User-Agent, and some
 * services refuse a request without one: GitHub's API answers 403 with an HTML page.
 */
export const pluginEngineUserAgent = "PluginEngine";

/** Name PluginEngine on requests that do not already carry a User-Agent. */
export const withPluginEngineUserAgent = (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, (request) =>
    request.headers["user-agent"] === undefined
      ? HttpClientRequest.setHeader(request, "user-agent", pluginEngineUserAgent)
      : request,
  );
