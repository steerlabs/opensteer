// oxlint-disable-next-line typescript/triple-slash-reference -- every program compiling this file needs the ambient module
/// <reference path="../contracts/swagger-client.d.ts" />
/** Swagger is most of the OpenAPI module's code. Discovery from a cached catalog never needs it,
 * so a cold app Worker evaluates it only when it resolves a document or builds a request.
 */

export type SwaggerClient = typeof import("swagger-client").default;
// oxlint-disable-next-line pluginEngine/authored-code-through-adapter -- dynamic import
export const loadSwaggerClient = () => import("swagger-client").then((module) => module.default);
