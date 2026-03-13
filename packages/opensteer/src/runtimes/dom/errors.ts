export type ElementPathErrorCode =
  | "ERR_PATH_CONTEXT_HOST_NOT_FOUND"
  | "ERR_PATH_CONTEXT_HOST_NOT_UNIQUE"
  | "ERR_PATH_IFRAME_UNAVAILABLE"
  | "ERR_PATH_SHADOW_ROOT_UNAVAILABLE"
  | "ERR_PATH_TARGET_NOT_FOUND"
  | "ERR_PATH_TARGET_NOT_UNIQUE";

export class ElementPathError extends Error {
  readonly code: ElementPathErrorCode;

  constructor(code: ElementPathErrorCode, message: string) {
    super(message);
    this.name = "ElementPathError";
    this.code = code;
  }
}
