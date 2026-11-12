/**
 * Frozen while wire-4 extensions are supported: the v2 invitation, the Host
 * discovery envelope, the Personal access route envelope and the Host
 * descriptor exactly as a shipped extension parses and verifies them, signing
 * bytes included. Never change a shape, a bound or a byte here
 * (docs/browser-sessions.md#chrome-sign-ins).
 */
export {
  HostBootstrapMethodSchema,
  HostDescriptorSchema,
  HostDiscoveryDeploymentSchema,
  HostDiscoveryDocumentSchema,
  HostDiscoveryEnvelopeSchema,
  hostDiscoverySigningBytes,
  type HostBootstrapMethod,
  type HostDescriptor,
  type HostDiscoveryDeployment,
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
} from "./authority.js";
export {
  BrowserSourceInvitationDestinationSchema,
  BrowserSourceInvitationDocumentSchema,
  BrowserSourceInvitationSchema,
  BrowserSourceOriginSchema,
  browserSourceInvitationPrefix,
  browserSourceInvitationSigningBytes,
  maximumBrowserSourceInvitationLength,
  type BrowserSourceInvitation,
  type BrowserSourceInvitationDestination,
  type BrowserSourceInvitationDocument,
} from "./browser-source.js";
export {
  PersonalAccessRouteGenerationSchema,
  PersonalAccessRouteKindSchema,
  PersonalAccessRouteOriginSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  maximumPersonalHostAccessRouteSigningBytes,
  personalHostAccessRouteSigningBytes,
  type PersonalAccessRouteGeneration,
  type PersonalAccessRouteKind,
  type PersonalAccessRouteOrigin,
  type PersonalHostAccessAuthority,
  type PersonalHostAccessRouteDocument,
  type PersonalHostAccessRouteEnvelope,
} from "./personal-access-route.js";
export {
  BrowserSourceIdSchema,
  CanonicalOriginSchema,
  decodeBase64Url,
  DeploymentIdSchema,
  DeploymentKindSchema,
  DeploymentShapeSchema,
  HostInstanceIdSchema,
  IsoDateTimeSchema,
  isLoopbackHostname,
  type BrowserSourceId,
  type DeploymentId,
  type DeploymentKind,
  type HostInstanceId,
} from "./primitives.js";
export {
  decodeBrowserSourceInvitation,
  verifyBrowserSourceChallenge,
  verifyBrowserSourcePairChallenge,
  verifyBrowserSourceRouteChanged,
  verifyHostDiscoveryEnvelope,
  verifyPersonalHostAccessRouteEnvelope,
} from "./verification.js";
