import { CloudDeploymentLifecycle } from "../cloud/lifecycle.js";
import { CloudMaterialCipher } from "../cloud/material.js";
import {
  GkeKubernetesManagedDeploymentClient,
  GoogleMetadataAccessTokenProvider,
  KubernetesManagedDeploymentProvider,
  readKubernetesManagedDeploymentTemplate,
} from "../cloud/kubernetes-managed-deployment-provider.js";
import { ControlPlaneAuthenticator, createControlPlaneAuth } from "../auth/auth.js";
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

const operationResultCleanupIntervalMilliseconds = 5 * 60 * 1_000;

export async function startControlPlane(config: ControlPlaneConfig): Promise<{
  readonly close: () => Promise<void>;
}> {
  assertNativeOAuthConfig(config);
  const database = createControlPlaneDatabase({ connectionString: config.databaseUrl });
  try {
    await migrateControlPlaneToLatest(database);
    const auth = createControlPlaneAuth(database, config);
    const connectLifecycle = new ConnectLifecycleService(
      database,
      new CloudflareConnectProvider(config.connectCloudflare),
      { managedConnectDomain: config.connectDomain },
    );
    const store = new ControlPlaneStore(database, config.publicOrigin, {
      adoptionCompletionGrantIssuer: new BetterAuthAccountAdoptionCompletionGrantIssuer(
        auth,
        config.publicOrigin,
      ),
      adoptionOperationCipher: new AdoptionOperationCipher(config.adoptionOperationKey),
      adoptionProofVerifier: new HttpHostAccountAdoptionProofVerifier(),
      managedDeploymentDomain: config.managedDeploymentDomain,
    });
    const cloudConfig = config.cloud;
    const cloudProvider = cloudConfig
      ? await (async () => {
          const template = await readKubernetesManagedDeploymentTemplate(cloudConfig.templatePath);
          const accessTokenProvider = new GoogleMetadataAccessTokenProvider();
          const clientForTemplate = (operationTemplate: typeof template) =>
            new GkeKubernetesManagedDeploymentClient({
              accessTokenProvider,
              ca: operationTemplate.kubernetesCa,
              server: operationTemplate.kubernetesApiServer,
            });
          return new KubernetesManagedDeploymentProvider({ clientForTemplate, template });
        })()
      : undefined;
    const cloudDeployments = new CloudDeploymentLifecycle(database, store, {
      issuer: config.publicOrigin.origin,
      domain: config.managedDeploymentDomain,
      ...(cloudConfig && cloudProvider
        ? {
            cipher: new CloudMaterialCipher(cloudConfig.operationKey),
            provider: cloudProvider,
          }
        : {}),
      onError: (operationId, error) =>
        server.log.error({ operationId, err: error }, "Cloud deployment reconciliation failed"),
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
      redirectUri: portalCallbackUri(config.publicOrigin, config.managedDeploymentDomain),
      scopes: portalOAuthScopes,
    });
    const server = await createControlPlaneServer(
      {
        auth,
        authenticator: new ControlPlaneAuthenticator(auth, database, config.publicOrigin),
        connectLifecycle,
        ...(cloudDeployments ? { cloudDeployments } : {}),
        ...(hostedOAuthBroker ? { hostedOAuthBroker } : {}),
        ...(config.desktopDownloadUrl ? { desktopDownloadUrl: config.desktopDownloadUrl } : {}),
        managedDeploymentDomain: config.managedDeploymentDomain,
        notifications,
        notificationPlatforms: [
          ...(apns ? ["ios" as const] : []),
          ...(fcm ? ["android" as const] : []),
        ],
        publicOrigin: config.publicOrigin,
        personalRemoteAccount,
        portalSessions,
        store,
      },
      { logger: config.environment !== "test" },
    );
    await store.purgeExpiredAdoptionResults();
    await personalRemoteAccount.purgeExpired();
    await portalSessions.purgeExpired();
    await hostedOAuthBrokerStore?.purgeExpired(new Date());
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

    const cleanup = setInterval(() => {
      void Promise.all([
        store.purgeExpiredAdoptionResults(),
        personalRemoteAccount.purgeExpired(),
        portalSessions.purgeExpired(),
        ...(hostedOAuthBrokerStore ? [hostedOAuthBrokerStore.purgeExpired(new Date())] : []),
      ]).catch((error) => server.log.error({ err: error }, "Operation result cleanup failed"));
    }, operationResultCleanupIntervalMilliseconds);
    cleanup.unref();

    let cloudWork: Promise<void> | undefined;
    const reconcileCloud = () => {
      if (!cloudDeployments.available || cloudWork) return;
      cloudWork = cloudDeployments
        .reconcile()
        .catch((error) => {
          server.log.error({ err: error }, "Cloud reconciliation failed");
        })
        .finally(() => {
          cloudWork = undefined;
        });
    };
    const cloudTimer = cloudDeployments.available ? setInterval(reconcileCloud, 5_000) : undefined;
    cloudTimer?.unref();
    reconcileCloud();

    let closePromise: Promise<void> | undefined;
    return {
      close: () => {
        closePromise ??= (async () => {
          clearInterval(cleanup);
          if (cloudTimer) clearInterval(cloudTimer);
          await cloudWork;
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
