import { OrganizationStore } from "../organizations/store.js";
import { CloudComputerClaimer, HttpManagedHomeClient } from "../cloud-computers/claim.js";
import { cloudComputerPortalPath } from "../cloud-computers/portal-pages.js";
import { CloudComputerStore } from "../cloud-computers/store.js";
import { CloudComputerStripe } from "../cloud-computers/stripe.js";
import { appleClientSecret } from "../auth/apple-sign-in.js";
import {
  ControlPlaneAuthenticator,
  createAccountProfiles,
  createControlPlaneAuth,
} from "../auth/auth.js";
import { BetterAuthAccountAdoptionCompletionGrantIssuer } from "../adoption/adoption-grant-issuer.js";
import { AdoptionOperationCipher } from "../adoption/adoption-operation-crypto.js";
import { HttpHostAccountAdoptionProofVerifier } from "../adoption/adoption-verifier.js";
import { CloudflareConnectProvider } from "../account/cloudflare-connect-provider.js";
import { assertNativeOAuthConfig, type ControlPlaneConfig } from "../config.js";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { HostedOAuthBrokerService } from "../auth/hosted-oauth-broker-service.js";
import { HostedOAuthBrokerStore } from "../auth/hosted-oauth-broker-store.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { PersonalAccountLinkOperationCipher } from "../account/personal-account-link-operation-crypto.js";
import { PersonalRemoteAccountService } from "../account/personal-remote-account.js";
import { TeamIdentityGrantService } from "../account/team-identity-grants.js";
import { portalCallbackUri, portalOAuthClientId, portalOAuthScopes } from "../portal/portal.js";
import { PortalSessionStore } from "../portal/portal-sessions.js";
import { createControlPlaneServer } from "./server.js";
import { ApnsClient } from "../notifications/apns-client.js";
import { FcmClient } from "../notifications/fcm-client.js";
import {
  NotificationDeliveryWorker,
  type PushSender,
} from "../notifications/notification-delivery-worker.js";
import { ControlPlaneNotificationStore } from "../notifications/notification-store.js";
import { NotificationTokenCipher } from "../notifications/notification-token-cipher.js";
import { ControlPlaneStore } from "../database/store.js";
import { HostedTeamStore } from "../hosted-teams/hosted-team-store.js";
import {
  HostedTeamBootstrapper,
  hostedTeamOwnerCheck,
} from "../hosted-teams/hosted-team-bootstrap.js";
import { HttpHostedTeamHost } from "../hosted-teams/hosted-team-host.js";
import { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { googleServiceAccountVerifier } from "../hosted-teams/provisioner-routes.js";

const operationResultCleanupIntervalMilliseconds = 5 * 60 * 1_000;

export async function startControlPlane(config: ControlPlaneConfig): Promise<{
  readonly close: () => Promise<void>;
}> {
  assertNativeOAuthConfig(config);
  const database = createControlPlaneDatabase({ connectionString: config.databaseUrl });
  let hostedTeamBootstrap: HostedTeamBootstrapper | undefined;
  let cloudComputerClaimer: CloudComputerClaimer | undefined;
  try {
    await migrateControlPlaneToLatest(database);
    const appleSignIn = config.appleSignIn;
    const auth = createControlPlaneAuth(database, {
      ...config,
      ...(appleSignIn
        ? {
            apple: {
              clientId: appleSignIn.clientId,
              clientSecret: await appleClientSecret(appleSignIn),
            },
          }
        : {}),
    });
    const connectLifecycle = new ConnectLifecycleService(
      database,
      new CloudflareConnectProvider(config.connectCloudflare),
      { managedConnectDomain: config.connectDomain },
    );
    const hostedTeamHost = new HttpHostedTeamHost();
    const ownerCheck = hostedTeamOwnerCheck({
      host: hostedTeamHost,
      issuer: config.publicOrigin,
      sign: async (claims) => (await auth.api.signJWT({ body: { payload: claims } })).token,
    });
    const hostedTeams = config.hostedTeams
      ? new HostedTeamStore(database, {
          cipher: new HostedTeamSetupTokenCipher(config.adoptionOperationKey),
          ownerCheck,
        })
      : undefined;
    const cloud = config.cloudComputers;
    const stripe = cloud
      ? new CloudComputerStripe({ key: cloud.stripeKey, returnUrl: config.publicOrigin })
      : undefined;
    const organizations = stripe
      ? new OrganizationStore(database, { stripe, offer: config.organizationOffer })
      : undefined;
    const cloudComputers =
      cloud && stripe
        ? new CloudComputerStore(database, {
            config: cloud,
            accountOrigin: config.publicOrigin,
            cipher: new HostedTeamSetupTokenCipher(config.adoptionOperationKey),
            stripe,
            ...(organizations ? { organizations } : {}),
            returnUrl: new URL(cloudComputerPortalPath, config.portalOrigin),
          })
        : undefined;
    const store = new ControlPlaneStore(database, config.publicOrigin, {
      adoptionCompletionGrantIssuer: new BetterAuthAccountAdoptionCompletionGrantIssuer(
        auth,
        config.publicOrigin,
      ),
      adoptionOperationCipher: new AdoptionOperationCipher(config.adoptionOperationKey),
      adoptionProofVerifier: new HttpHostAccountAdoptionProofVerifier(),
      portalOrigin: config.portalOrigin,
    });
    const personalRemoteAccount = new PersonalRemoteAccountService({
      auth,
      database,
      issuer: config.publicOrigin,
      operationCipher: new PersonalAccountLinkOperationCipher(
        config.personalAccountLinkOperationKey,
      ),
    });
    const portalSessions = new PortalSessionStore(database);
    const hostedOAuthBrokerStore = config.hostedOAuth
      ? new HostedOAuthBrokerStore(database)
      : undefined;
    const hostedOAuthBroker =
      config.hostedOAuth && hostedOAuthBrokerStore
        ? new HostedOAuthBrokerService({
            applications: config.hostedOAuth.applications,
            encryptionPrivateKey: config.hostedOAuth.encryptionPrivateKey,
            issuer: config.publicOrigin,
            attemptContextEncryptionKey: config.hostedOAuth.attemptContextEncryptionKey,
            store: hostedOAuthBrokerStore,
          })
        : undefined;

    const push = config.push;
    // Withdrawing a registration needs only the database, so the store exists
    // even with no provider: sign-out must never depend on Apple or Google.
    const notifications = new ControlPlaneNotificationStore(database, {
      cipher: new NotificationTokenCipher(config.authSecret),
    });
    const apns = push?.apns ? new ApnsClient(push.apns) : undefined;
    const fcm = push?.fcm ? new FcmClient(push.fcm) : undefined;

    await store.ensureOfficialNativeClients({ clients: config.nativeOAuthClients });
    await store.ensureOfficialPortalClient({
      clientId: portalOAuthClientId,
      redirectUri: portalCallbackUri(config.portalOrigin),
      scopes: portalOAuthScopes,
    });
    const server = await createControlPlaneServer(
      {
        ...(appleSignIn ? { appleSignIn } : {}),
        ...(config.appReview ? { appReviewSignIn: true } : {}),
        auth,
        authenticator: new ControlPlaneAuthenticator(auth, database, config.publicOrigin),
        connectLifecycle,
        ...(hostedOAuthBroker ? { hostedOAuthBroker } : {}),
        ...(organizations ? { organizations } : {}),
        ...(cloud && cloudComputers
          ? {
              cloudComputers: {
                store: cloudComputers,
                kickBootstrap: () => cloudComputerClaimer?.kick(),
                stripeWebhookSecret: cloud.stripeWebhookSecret,
                verifyProvisioner: googleServiceAccountVerifier({
                  audience: config.publicOrigin.origin,
                  email: cloud.provisionerEmail,
                }),
              },
            }
          : {}),
        ...(config.hostedTeams && hostedTeams
          ? {
              hostedTeams: {
                store: hostedTeams,
                kickBootstrap: () => hostedTeamBootstrap?.kick(),
                verifyProvisioner: googleServiceAccountVerifier({
                  audience: config.publicOrigin.origin,
                  email: config.hostedTeams.provisionerEmail,
                }),
              },
            }
          : {}),
        ...(config.iosAppUrl ? { iosAppUrl: config.iosAppUrl } : {}),
        ...(config.androidAppUrl ? { androidAppUrl: config.androidAppUrl } : {}),
        ...(config.desktopDownloadUrl ? { desktopDownloadUrl: config.desktopDownloadUrl } : {}),
        portalOrigin: config.portalOrigin,
        notifications,
        notificationPlatforms: [
          ...(apns ? ["ios" as const] : []),
          ...(fcm ? ["android" as const] : []),
        ],
        publicOrigin: config.publicOrigin,
        personalRemoteAccount,
        portalSessions,
        store,
        teamIdentityGrants: new TeamIdentityGrantService({
          auth,
          database,
          issuer: config.publicOrigin,
        }),
        accountProfiles: createAccountProfiles(auth, database, config.publicOrigin),
      },
      { logger: config.environment !== "test" },
    );
    await store.purgeExpiredAdoptionResults();
    await personalRemoteAccount.purgeExpired();
    await portalSessions.purgeExpired();
    await hostedOAuthBrokerStore?.purgeExpired(new Date());
    const billingError = () => server.log.error("Cloud Computer billing reconciliation failed");
    await cloudComputers?.checkOffer().catch(billingError);
    await organizations?.checkOffer().catch(billingError);
    await server.listen({ host: config.listenHost, port: config.listenPort });

    server.log.info({ apns: Boolean(apns), fcm: Boolean(fcm) }, "Push providers configured");

    const notificationDelivery =
      apns || fcm
        ? new NotificationDeliveryWorker({
            onSettledFailure: (failure) =>
              server.log.warn(failure, "Notification delivery settled failed"),
            onError: (error) => server.log.error({ err: error }, "Notification delivery failed"),
            senders: {
              ...(fcm
                ? { android: (message: Parameters<typeof fcm.send>[0]) => fcm.send(message) }
                : {}),
              ...(apns
                ? {
                    ios: (message: Parameters<PushSender>[0]) => {
                      if (message.apsEnvironment === null)
                        throw new Error("iOS delivery has no APNs environment");
                      return apns.send({ ...message, apsEnvironment: message.apsEnvironment });
                    },
                  }
                : {}),
            },
            store: notifications,
          })
        : undefined;
    notificationDelivery?.start();

    hostedTeamBootstrap = hostedTeams
      ? new HostedTeamBootstrapper({
          teams: hostedTeams,
          accounts: store,
          host: hostedTeamHost,
          ownerCheck,
          issuer: config.publicOrigin,
          onError: (error) => server.log.error({ err: error }, "Hosted team setup failed"),
        })
      : undefined;
    hostedTeamBootstrap?.start();
    cloudComputerClaimer = cloudComputers
      ? new CloudComputerClaimer({
          store: cloudComputers,
          home: new HttpManagedHomeClient(),
          issuer: config.publicOrigin,
          sign: async (claims) => (await auth.api.signJWT({ body: { payload: claims } })).token,
          onError: (error) => server.log.error({ err: error }, "Cloud Computer claim failed"),
        })
      : undefined;
    cloudComputerClaimer?.start();

    let billingPass: Promise<void> | undefined;
    const runBilling = () => {
      if (!billingPass && cloudComputers) {
        billingPass = cloudComputers
          .reconcileBilling(billingError)
          .catch(billingError)
          .finally(() => {
            billingPass = undefined;
          });
      }
    };
    const billingTimer = cloudComputers ? setInterval(runBilling, 60_000) : undefined;
    billingTimer?.unref();
    runBilling();

    const cleanup = setInterval(() => {
      void Promise.all([
        store.purgeExpiredAdoptionResults(),
        personalRemoteAccount.purgeExpired(),
        portalSessions.purgeExpired(),
        ...(hostedOAuthBrokerStore ? [hostedOAuthBrokerStore.purgeExpired(new Date())] : []),
      ]).catch((error) => server.log.error({ err: error }, "Operation result cleanup failed"));
    }, operationResultCleanupIntervalMilliseconds);
    cleanup.unref();

    let closePromise: Promise<void> | undefined;
    return {
      close: () => {
        closePromise ??= (async () => {
          clearInterval(cleanup);
          clearInterval(billingTimer);
          await billingPass;
          await hostedTeamBootstrap?.close();
          await cloudComputerClaimer?.close();
          await notificationDelivery?.close();
          apns?.close();
          await server.close();
          await database.destroy();
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await database.destroy();
    throw error;
  }
}
