import type { CookieRecord } from "@opensteer/browser-core";

export const cloudActionMethods = [
  "goto",
  "snapshot",
  "screenshot",
  "state",
  "click",
  "dblclick",
  "rightclick",
  "hover",
  "input",
  "select",
  "scroll",
  "tabs",
  "newTab",
  "switchTab",
  "closeTab",
  "getCookies",
  "setCookie",
  "clearCookies",
  "pressKey",
  "type",
  "getElementText",
  "getElementValue",
  "getElementAttributes",
  "getElementBoundingBox",
  "getHtml",
  "getTitle",
  "uploadFile",
  "exportCookies",
  "importCookies",
  "waitForText",
  "extract",
  "extractFromPlan",
  "clearCache",
] as const;

export type CloudActionMethod = (typeof cloudActionMethods)[number];

export const cloudErrorCodes = [
  "CLOUD_AUTH_FAILED",
  "CLOUD_SESSION_NOT_FOUND",
  "CLOUD_SESSION_CLOSED",
  "CLOUD_UNSUPPORTED_METHOD",
  "CLOUD_INVALID_REQUEST",
  "CLOUD_MODEL_NOT_ALLOWED",
  "CLOUD_ACTION_FAILED",
  "CLOUD_CAPACITY_EXHAUSTED",
  "CLOUD_RUNTIME_UNAVAILABLE",
  "CLOUD_RUNTIME_MISMATCH",
  "CLOUD_SESSION_STALE",
  "CLOUD_CONTROL_PLANE_ERROR",
  "CLOUD_CONTRACT_MISMATCH",
  "CLOUD_PROXY_UNAVAILABLE",
  "CLOUD_PROXY_REQUIRED",
  "CLOUD_BILLING_LIMIT_REACHED",
  "CLOUD_RATE_LIMITED",
  "CLOUD_BROWSER_PROFILE_NOT_FOUND",
  "CLOUD_BROWSER_PROFILE_BUSY",
  "CLOUD_BROWSER_PROFILE_DISABLED",
  "CLOUD_BROWSER_PROFILE_NOT_READY",
  "CLOUD_BROWSER_PROFILE_PROXY_UNAVAILABLE",
  "CLOUD_BROWSER_PROFILE_SYNC_FAILED",
  "CLOUD_INTERNAL",
] as const;

export type CloudErrorCode = (typeof cloudErrorCodes)[number];

export const cloudSessionStatuses = [
  "provisioning",
  "active",
  "closing",
  "closed",
  "failed",
] as const;

export type CloudSessionStatus = (typeof cloudSessionStatuses)[number];

export const cloudSessionContractVersion = "v3" as const;
export type CloudSessionContractVersion = typeof cloudSessionContractVersion;

export const cloudSessionSourceTypes = [
  "agent-thread",
  "agent-run",
  "project-agent-run",
  "local-cloud",
  "manual",
] as const;

export type CloudSessionSourceType = (typeof cloudSessionSourceTypes)[number];
export type CloudSessionVisibilityScope = "team" | "owner";
export type CloudProxyMode = "disabled" | "optional" | "required";
export type CloudProxyProtocol = "http" | "https" | "socks5";
export type CloudFingerprintMode = "off" | "auto";
export type BrowserProfileStatus = "active" | "archived" | "error";
export type BrowserProfileProxyPolicy = "strict_sticky";
export type BrowserProfileArchiveFormat = "tar.gz";
export type PortableBrowserProfileSnapshotFormat = "portable-cookies-v1+json.gz";
export type PortableBrowserFamily = "chromium";
export type BrowserProfileImportStatus =
  | "awaiting_upload"
  | "queued"
  | "processing"
  | "ready"
  | "failed";

export interface PortableBrowserProfileSnapshotSource {
  readonly browserFamily: PortableBrowserFamily;
  readonly browserName?: string;
  readonly browserMajor?: string;
  readonly browserBrand?: string;
  readonly captureMethod?: string;
  readonly platform?: string;
  readonly capturedAt: number;
}

export type PortableBrowserProfileCookieRecord = Omit<CookieRecord, "sessionRef">;

export interface PortableBrowserProfileSnapshot {
  readonly version: "portable-cookies-v1";
  readonly source: PortableBrowserProfileSnapshotSource;
  readonly cookies: readonly PortableBrowserProfileCookieRecord[];
}

export interface BrowserProfileImportSnapshotSummary {
  readonly source: PortableBrowserProfileSnapshotSource;
  readonly cookieCount: number;
  readonly domainCount: number;
}

export interface CloudViewport {
  readonly width: number;
  readonly height: number;
}

export interface CloudGeolocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy?: number;
}

export interface CloudBrowserContextConfig {
  readonly viewport?: CloudViewport;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly geolocation?: CloudGeolocation;
  readonly colorScheme?: "light" | "dark" | "no-preference";
  readonly userAgent?: string;
  readonly javaScriptEnabled?: boolean;
  readonly ignoreHTTPSErrors?: boolean;
}

export interface CloudBrowserExtensionConfig {
  readonly includeDefaults?: boolean;
  readonly extensionKeys?: readonly string[];
}

export interface CloudBrowserLaunchConfig {
  readonly headless?: boolean;
  readonly context?: CloudBrowserContextConfig;
  readonly chromeArgs?: readonly string[];
  readonly extensions?: CloudBrowserExtensionConfig;
}

export interface CloudProxyPreference {
  readonly mode?: CloudProxyMode;
  readonly countryCode?: string;
  readonly region?: string;
  readonly city?: string;
  readonly proxyId?: string;
}

export interface CloudFingerprintPreference {
  readonly mode?: CloudFingerprintMode;
  readonly locales?: readonly string[];
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly slim?: boolean;
}

export interface CloudBrowserProfilePreference {
  readonly profileId: string;
  readonly reuseIfActive?: boolean;
}

export type CloudBrowserProfileLaunchPreference = CloudBrowserProfilePreference;

export interface CloudSessionLaunchConfig {
  readonly browser?: CloudBrowserLaunchConfig;
  readonly proxy?: CloudProxyPreference;
  readonly fingerprint?: CloudFingerprintPreference;
  readonly browserProfile?: CloudBrowserProfilePreference;
}

export interface CloudSessionCreateRequest {
  readonly cloudSessionContractVersion: CloudSessionContractVersion;
  readonly sourceType: "local-cloud";
  readonly clientSessionHint: string;
  readonly localRunId: string;
  readonly name?: string;
  readonly model?: string;
  readonly launchContext?: Readonly<Record<string, unknown>>;
  readonly launchConfig?: CloudSessionLaunchConfig;
}

export interface CloudSessionSummary {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly state: CloudSessionStatus;
  readonly createdAt: number;
  readonly sourceType: CloudSessionSourceType;
  readonly sourceRef?: string;
  readonly label?: string;
}

export interface CloudSessionCreateResponse {
  readonly sessionId: string;
  readonly actionWsUrl: string;
  readonly cdpWsUrl: string;
  readonly actionToken: string;
  readonly cdpToken: string;
  readonly expiresAt?: number;
  readonly cloudSessionUrl: string;
  readonly cloudSession: CloudSessionSummary;
}

export interface CloudSelectorCacheImportEntry {
  readonly namespace: string;
  readonly siteOrigin: string;
  readonly method: string;
  readonly descriptionHash: string;
  readonly path: unknown;
  readonly schemaHash?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CloudSelectorCacheImportRequest {
  readonly entries: readonly CloudSelectorCacheImportEntry[];
}

export interface CloudSelectorCacheImportResponse {
  readonly imported: number;
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
}

export type ActionFailureCode =
  | "TARGET_NOT_FOUND"
  | "TARGET_UNAVAILABLE"
  | "TARGET_STALE"
  | "TARGET_AMBIGUOUS"
  | "BLOCKED_BY_INTERCEPTOR"
  | "NOT_VISIBLE"
  | "NOT_ENABLED"
  | "NOT_EDITABLE"
  | "INVALID_TARGET"
  | "INVALID_OPTIONS"
  | "ACTION_TIMEOUT"
  | "UNKNOWN";

export type ActionFailureClassificationSource =
  | "typed_error"
  | "playwright_call_log"
  | "dom_probe"
  | "message_heuristic"
  | "unknown";

export interface ActionFailureBlocker {
  readonly tag: string;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly role: string | null;
  readonly text: string | null;
}

export interface ActionFailureDetails {
  readonly blocker?: ActionFailureBlocker;
  readonly observation?: string;
}

export interface ActionFailure {
  readonly code: ActionFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly classificationSource: ActionFailureClassificationSource;
  readonly details?: ActionFailureDetails;
}

export interface CloudActionRequest {
  readonly id: number;
  readonly method: CloudActionMethod;
  readonly args: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  readonly token: string;
}

export interface CloudActionSuccess {
  readonly id: number;
  readonly ok: true;
  readonly result: unknown;
}

export interface CloudActionFailureDetails {
  readonly actionFailure?: ActionFailure;
}

export interface CloudActionFailure {
  readonly id: number;
  readonly ok: false;
  readonly error: string;
  readonly code: CloudErrorCode;
  readonly details?: CloudActionFailureDetails;
}

export type CloudActionResponse = CloudActionSuccess | CloudActionFailure;

export interface BrowserProfileDescriptor {
  readonly profileId: string;
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly status: BrowserProfileStatus;
  readonly proxyPolicy: BrowserProfileProxyPolicy;
  readonly stickyProxyId?: string;
  readonly proxyCountryCode?: string;
  readonly proxyRegion?: string;
  readonly proxyCity?: string;
  readonly fingerprintMode: CloudFingerprintMode;
  readonly fingerprintHash?: string;
  readonly activeSessionId?: string;
  readonly lastSessionId?: string;
  readonly lastLaunchedAt?: number;
  readonly latestRevision?: number;
  readonly latestStorageId?: string;
  readonly latestSizeBytes?: number;
  readonly latestArchiveSha256?: string;
  readonly latestArchiveFormat?: BrowserProfileArchiveFormat;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
}

export interface BrowserProfileListResponse {
  readonly profiles: readonly BrowserProfileDescriptor[];
  readonly nextCursor?: string;
}

export interface BrowserProfileCreateRequest {
  readonly name: string;
  readonly proxy?: {
    readonly proxyId?: string;
    readonly countryCode?: string;
    readonly region?: string;
    readonly city?: string;
  };
  readonly fingerprint?: {
    readonly mode?: CloudFingerprintMode;
  };
}

export interface BrowserProfileImportCreateRequest {
  readonly profileId: string;
}

export interface BrowserProfileImportCreateResponse {
  readonly importId: string;
  readonly profileId: string;
  readonly status: BrowserProfileImportStatus;
  readonly uploadUrl: string;
  readonly uploadMethod: "PUT";
  readonly uploadFormat: PortableBrowserProfileSnapshotFormat;
  readonly maxUploadBytes: number;
}

export interface BrowserProfileImportDescriptor {
  readonly importId: string;
  readonly profileId: string;
  readonly status: BrowserProfileImportStatus;
  readonly uploadFormat: PortableBrowserProfileSnapshotFormat;
  readonly storageId?: string;
  readonly revision?: number;
  readonly error?: string;
  readonly snapshotSummary?: BrowserProfileImportSnapshotSummary;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const cloudActionMethodSet = new Set<CloudActionMethod>(cloudActionMethods);
const cloudErrorCodeSet = new Set<CloudErrorCode>(cloudErrorCodes);
const cloudSessionSourceTypeSet = new Set<CloudSessionSourceType>(cloudSessionSourceTypes);
const cloudSessionStatusSet = new Set<CloudSessionStatus>(cloudSessionStatuses);

export function isCloudActionMethod(value: unknown): value is CloudActionMethod {
  return typeof value === "string" && cloudActionMethodSet.has(value as CloudActionMethod);
}

export function isCloudErrorCode(value: unknown): value is CloudErrorCode {
  return typeof value === "string" && cloudErrorCodeSet.has(value as CloudErrorCode);
}

export function isCloudSessionSourceType(value: unknown): value is CloudSessionSourceType {
  return (
    typeof value === "string" && cloudSessionSourceTypeSet.has(value as CloudSessionSourceType)
  );
}

export function isCloudSessionStatus(value: unknown): value is CloudSessionStatus {
  return typeof value === "string" && cloudSessionStatusSet.has(value as CloudSessionStatus);
}
