import { z } from "zod";

type RpcMethod = "GET" | "POST";

export interface RpcDeclaration<
  Payload extends z.ZodType = z.ZodType,
  Success extends z.ZodType = z.ZodType,
  Error extends z.ZodType = z.ZodType,
> {
  readonly error: Error;
  readonly method: RpcMethod;
  readonly payload: Payload;
  readonly success: Success;
  readonly stream?: true;
  readonly binaryRequest?: true;
}

export type RpcGroup = Readonly<Record<string, RpcDeclaration>>;

export type RpcResult<Success, Error> =
  { readonly data: Success; readonly ok: true } | { readonly error: Error; readonly ok: false };

export type RpcInput<Declaration extends RpcDeclaration> = z.input<Declaration["payload"]>;
type RpcPayload<Declaration extends RpcDeclaration> = z.output<Declaration["payload"]>;
type RpcSuccess<Declaration extends RpcDeclaration> = z.output<Declaration["success"]>;
export type RpcError<Declaration extends RpcDeclaration> = z.output<Declaration["error"]>;
export type RpcOutput<Declaration extends RpcDeclaration> = RpcResult<
  RpcSuccess<Declaration>,
  RpcError<Declaration>
>;

export type RpcHandlers<Api extends RpcGroup, Context> = {
  readonly [Name in keyof Api]: (
    payload: RpcPayload<Api[Name]>,
    context: Context,
  ) => Promise<RpcOutput<Api[Name]>> | RpcOutput<Api[Name]>;
};

/** Per-call transport controls. Cancellation belongs to the caller, not to the
 * declaration, so it travels beside the payload instead of inside it. */
export interface RpcCallOptions {
  readonly body?: Blob | Uint8Array;
  readonly signal?: AbortSignal;
  /** Override for binary uploads or operations that deliberately wait before headers. */
  readonly responseHeadersTimeoutMs?: number;
  /** Maximum silence between response bytes, never a whole-body duration cap. */
  readonly bodyStallTimeoutMs?: number;
}

export type RpcClient<Api extends RpcGroup> = {
  readonly [Name in keyof Api]: (
    input: RpcInput<Api[Name]>,
    options?: RpcCallOptions,
  ) => Promise<RpcOutput<Api[Name]>>;
};

/**
 * One declaration record owns each HTTP contract. Its Zod payload, success,
 * error, and stream schemas derive both the exhaustive server handler map and
 * typed client; mutations enter through the single commands.dispatch member.
 */
export function defineRpc<const Api extends RpcGroup>(api: Api): Api {
  return api;
}

export function rpcSuccess<const Value>(data: Value): RpcResult<Value, never> {
  return { data, ok: true };
}

export function rpcFailure<const Error>(error: Error): RpcResult<never, Error> {
  return { error, ok: false };
}
