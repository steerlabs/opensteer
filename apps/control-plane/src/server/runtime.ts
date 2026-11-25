import { billingErrorDetails, billingEvent } from "../cloud-computers/billing-error.js";
import { logAccountEvent } from "./events.js";
import { sendHeartbeat } from "@opensteer/shared/heartbeat";
import { AgentDirectoryStore } from "../agent-directory/store.js";
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
import {
  CloudflareConnectProvider,
  type ConnectResourceProvider,
} from "../account/cloudflare-connect-provider.js";
import { assertNativeOAuthConfig, type ControlPlaneConfig } from "../config.js";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { HostedOAuthBrokerService } from "../auth/hosted-oauth-broker-service.js";
import { HostedOAuthBrokerStore } from "../auth/hosted-oauth-broker-store.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { PersonalAccountLinkOperationCipher } from "../account/personal-account-link-operation-crypto.js";
import { PersonalRemoteAccountService } from "../account/personal-remote-account.js";
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
import { CloudComputerSecretCipher } from "../cloud-computers/secret-cipher.js";
import { googleServiceAccountVerifier } from "../cloud-computers/provisioner-verifier.js";

const operationResultCleanupIntervalMilliseconds = 5 * 60 * 1_000;

/**
 * What a caller may hand the account service instead of building it from its configuration.
 * Only the tunnel provider: a journey that runs the real account code on a machine with no
 * Cloudflare credential passes a stand-in here. `main.ts` passes nothing, and the configuration
 * has no field that names a provider, so a deployed account service always builds Cloudflare's.
 */
export interface ControlPlaneDependencies {
  readonly connectProvider?: ConnectResourceProvider;
}

export async function startControlPlane(
  config: ControlPlaneConfig,
  dependencies: ControlPlaneDependencies = {},
): Promise<{
  readonly close: () => Promise<void>;
}> {
  assertNativeOAuthConfig(config);
  const database = createControlPlaneDatabase({ connectionString: config.databaseUrl });
  let cloudComputerClaimer: CloudComputerClaimer | undefined;
  // Does nothing until the billing pass is set up below; its minute timer covers that.
  let runBilling = (): void => undefined;
  // The store reports billing attention before the server and its logger exist.
  let logger: Parameters<typeof logAccountEvent>[0] | undefined;
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
      dependencies.connectProvider ?? new CloudflareConnectProvider(config.connectCloudflare),
      { managedConnectDomain: config.connectDomain },
    );
    const cloud = config.cloudComputers;
    const stripe = cloud
      ? new CloudComputerStripe({ key: cloud.stripeKey, returnUrl: config.publicOrigin })
      : undefined;
    const cloudComputers =
      cloud && stripe
        ? new CloudComputerStore(database, {
            config: cloud,
            accountOrigin: config.publicOrigin,
            cipher: new CloudComputerSecretCipher(config.adoptionOperationKey),
            stripe,
            returnUrl: new URL(cloudComputerPortalPath, config.portalOrigin),
            onBillingAttention: (message) =>
              logAccountEvent(logger ?? console, "account.billing.failed", {}, message),
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
        agentDirectory: new AgentDirectoryStore(database),
        ...(cloud && cloudComputers
          ? {
              cloudComputers: {
                store: cloudComputers,
                kickBootstrap: () => cloudComputerClaimer?.kick(),
                kickBilling: () => runBilling(),
                stripeWebhookSecret: cloud.stripeWebhookSecret,
                ...(config.websiteOrigin ? { websiteOrigin: config.websiteOrigin } : {}),
                verifyProvisioner: googleServiceAccountVerifier({
                  audience: config.publicOrigin.origin,
                  email: cloud.provisionerEmail,
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
        accountProfiles: createAccountProfiles(auth, database, config.publicOrigin),
      },
      { logger: config.environment !== "test" },
    );
    await store.purgeExpiredAdoptionResults();
    await personalRemoteAccount.purgeExpired();
    await portalSessions.purgeExpired();
    await hostedOAuthBrokerStore?.purgeExpired(new Date());
    logger = server.log;
    const billingError = (error: unknown) =>
      logAccountEvent(
        server.log,
        billingEvent(error),
        billingErrorDetails(error),
        "Cloud Computer billing reconciliation failed",
      );
    await cloudComputers?.checkOffer().catch(billingError);
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

    cloudComputerClaimer = cloudComputers
      ? new CloudComputerClaimer({
          store: cloudComputers,
          home: new HttpManagedHomeClient(),
          issuer: config.publicOrigin,
          sign: async (claims) => (await auth.api.signJWT({ body: { payload: claims } })).token,
          onError: (error) =>
            logAccountEvent(
              server.log,
              "account.cloud_computer.claim_failed",
              { err: error },
              "Cloud Computer claim failed",
            ),
        })
      : undefined;
    cloudComputerClaimer?.start();

    let billingPass: Promise<boolean | void> | undefined;
    runBilling = () => {
      if (!billingPass && cloudComputers && cloud) {
        // A heartbeat only after a pass that ran here, start to end, with nothing failing.
        let failed = false;
        const passError = (error: unknown) => {
          failed = true;
          billingError(error);
        };
        billingPass = cloudComputers
          .reconcileBilling(passError, {
            notReadyAfterMs: cloud.notReadyAfterMinutes * 60_000,
            onFinding: ({ event, ...fields }) => logAccountEvent(server.log, event, fields),
          })
          .then((ran) => {
            if (ran && !failed)
              sendHeartbeat(cloud.heartbeatUrl, {
                onError: (status) =>
                  logAccountEvent(server.log, "account.heartbeat.failed", { status }),
              });
            return ran;
          })
          .catch(billingError)
          .finally(() => {
            billingPass = undefined;
          });
      }
    };
    const billingTimer = cloudComputers ? setInterval(runBilling, 60_000) : undefined;
    billingTimer?.unref();
    runBilling();

    let backupPass: Promise<void> | undefined;
    const backupError = () =>
      logAccountEvent(
        server.log,
        "account.backup.erasure_pending",
        {},
        "Cloud Computer backup erasure is pending",
      );
    const runBackupErasure = () => {
      if (!backupPass && cloudComputers) {
        backupPass = cloudComputers
          .reconcileBackupErasure(backupError)
          .catch(backupError)
          .finally(() => {
            backupPass = undefined;
          });
      }
    };
    const backupTimer = cloudComputers ? setInterval(runBackupErasure, 15_000) : undefined;
    backupTimer?.unref();
    runBackupErasure();

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
          clearInterval(backupTimer);
          await billingPass;
          await backupPass;
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
