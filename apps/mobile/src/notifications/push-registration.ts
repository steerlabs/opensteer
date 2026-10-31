import {
  clientPublicDetail,
  DeviceLimitReachedError,
  PushNotConfiguredError,
  type PrivateFilesystem,
} from "@opensteer/client/connections";
import {
  NotificationDevicePlatformSchema,
  NotificationDeviceTokenSchema,
  RegisterNotificationDeviceRequestSchema,
  NotificationInstallationIdSchema,
  type NotificationDevicePlatform,
  type RegisterNotificationDeviceRequest,
} from "@opensteer/control-plane-protocol";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { z } from "zod";

/**
 * Whether this phone can be sent a notification, and why it cannot when it
 * cannot. Every value is a settled answer a person can act on — there is no
 * "checking" state, because the only screen that reads this shows a sentence,
 * and a sentence that says nothing is worse than the honest one underneath it.
 */
export type PushRegistrationStatus =
  /** This build names no Opensteer Account service, so there is nobody to register with. */
  | "no-account-service"
  | "signed-out"
  /** Nobody has been asked yet. */
  | "permission-undetermined"
  /** The operating system says no, and only its own Settings can change that. */
  | "permission-denied"
  /** The Account service has no sender for this platform. */
  | "push-not-configured"
  /** This Account has registered as many phones as it may; the repair is elsewhere. */
  | "device-limit"
  | "registered"
  /** Something between here and the Account failed; `detail` says what. */
  | "unavailable";

export interface NotificationPreferences {
  readonly approvalsEnabled: boolean;
  readonly runOutcomesEnabled: boolean;
}

/**
 * `unavailable` is the one state that carries a reason, and it carries it
 * always: a failure this app cannot explain is one it should not be reporting.
 */
export type PushRegistrationState =
  | {
      readonly preferences: NotificationPreferences;
      readonly status: Exclude<PushRegistrationStatus, "unavailable">;
    }
  | {
      readonly detail: string;
      readonly preferences: NotificationPreferences;
      readonly status: "unavailable";
    };

/** What the operating system currently allows, reduced to what decides a screen. */
export interface PushPermissionState {
  /** False once the person has answered no: only the system's Settings reopens it. */
  readonly canAskAgain: boolean;
  readonly granted: boolean;
}

export interface PushPermissions {
  current(): Promise<PushPermissionState>;
  request(): Promise<PushPermissionState>;
}

/**
 * The raw APNs or FCM token for this install. It is the provider's, not Expo's:
 * the Account sends to the provider directly, so an Expo push token would name
 * a service this product does not use.
 */
export interface PushTokenSource {
  apsEnvironment(): Promise<"development" | "production">;
  current(): Promise<string>;
  /**
   * Announces a token the provider rolled. Expo also announces the token on
   * every `current()` read, so the listener is told what the token is.
   */
  subscribe(listener: (token: string) => void): () => void;
}

/** The two Account routes this app calls, with the bearer already arranged. */
export interface NotificationDeviceRegistry {
  register(installationId: string, request: RegisterNotificationDeviceRequest): Promise<unknown>;
  unregister(installationId: string): Promise<unknown>;
}

const maximumStateFileBytes = 4 * 1_024;
const installationIdBytes = 18;

const RegisteredDeviceSchema = z.strictObject({
  accountSubject: z.string().min(1).max(256),
  approvalsEnabled: z.boolean(),
  platform: NotificationDevicePlatformSchema,
  runOutcomesEnabled: z.boolean(),
  token: NotificationDeviceTokenSchema,
});
type RegisteredDevice = z.infer<typeof RegisteredDeviceSchema>;

/**
 * What this install remembers about its own registration.
 *
 * `installationId` is generated once and kept out of the deployment catalog:
 * the catalog is projected from the Account directory and rewritten by every
 * sync, and an identifier that survives exactly as long as the install must not
 * live somewhere a sync can drop it.
 *
 * `registered` remembers whether sign-out owes an unregister while the Account
 * credential is still available. It never suppresses a registration PUT.
 */
const PushStateFileSchema = z.strictObject({
  installationId: NotificationInstallationIdSchema,
  preferences: z.strictObject({ approvalsEnabled: z.boolean(), runOutcomesEnabled: z.boolean() }),
  registered: RegisteredDeviceSchema.nullable(),
  schemaVersion: z.literal(1),
});
type PushStateFile = z.infer<typeof PushStateFileSchema>;

export interface PushRegistrationOptions {
  /** False in a build with no `EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN`. */
  readonly accountConfigured: boolean;
  readonly filePath: string;
  readonly permissions: PushPermissions;
  readonly platform: NotificationDevicePlatform;
  readonly privateFiles: PrivateFilesystem;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly registry: NotificationDeviceRegistry;
  /**
   * The Account subject signed in right now, or null. The device routes take
   * the mobile Account bearer, so being signed in is a precondition of
   * registering at all — and a different subject is a different registration.
   */
  readonly signedInSubject: () => Promise<string | null>;
  readonly tokens: PushTokenSource;
}

/**
 * The one thing that decides whether this phone is registered for push.
 *
 * It is a state machine over four inputs — the build's Account service, who is
 * signed in, what the operating system permits, and what the person chose —
 * and it holds exactly one registration, keyed by an installation id this
 * install generated once. `sync` is idempotent and is the only path that
 * reaches the network: sign-in, a foreground, a rolled provider token and a
 * preference change all call it. Every eligible sync PUTs so a registration
 * disabled by the provider is revived even when the token has not changed.
 *
 * Signing out is deliberately not part of `sync`. The registration has to be
 * withdrawn while the Account credential still exists, so `signOut()` runs
 * before the credential is revoked; afterwards there is no bearer to withdraw
 * it with and the row would outlive the phone's ability to remove it.
 */
export class PushRegistration {
  readonly #listeners = new Set<() => void>();
  readonly #options: PushRegistrationOptions;
  readonly #queue = new MutationQueue();

  #detachToken: (() => void) | null = null;
  #file: PushStateFile | null = null;
  #announcedDuringRead: string | null = null;
  #knownToken: string | null = null;
  #readingToken = false;
  #state: PushRegistrationState = {
    preferences: { approvalsEnabled: true, runOutcomesEnabled: true },
    status: "signed-out",
  };

  constructor(options: PushRegistrationOptions) {
    this.#options = options;
  }

  registeredAccountSubject(): Promise<string | null> {
    return this.#queue.run(async () =>
      this.#state.status === "registered"
        ? ((await this.#load()).registered?.accountSubject ?? null)
        : null,
    );
  }

  installationId(): Promise<string> {
    return this.#queue.run(async () => (await this.#load()).installationId);
  }

  getSnapshot = (): PushRegistrationState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Reads what this install remembers, watches the token, and registers. */
  async start(): Promise<void> {
    this.#detachToken ??= this.#options.tokens.subscribe((token) => {
      // Registering on our own read's announcement would read again and loop;
      // only a token this install has not yet sent is news. One heard mid-read
      // is judged against what the read returns.
      if (this.#readingToken) {
        this.#announcedDuringRead = token;
        return;
      }
      if (token === this.#knownToken) return;
      void this.#queue.run(() => this.#sync(token));
    });
    await this.sync();
  }

  /**
   * Runs the state machine once. Safe to call from anywhere and at any time:
   * calls are serialized and every eligible pass sends the registration.
   */
  async sync(): Promise<void> {
    await this.#queue.run(() => this.#sync());
  }

  /** Asks the operating system, then registers if the answer was yes. */
  async requestPermission(): Promise<void> {
    await this.#queue.run(async () => {
      await this.#options.permissions.request();
      await this.#sync();
    });
  }

  /** A successful message is the first moment an alert about its reply is useful. */
  async afterSuccessfulSend(): Promise<void> {
    await this.#queue
      .run(async () => {
        if (!this.#options.accountConfigured || (await this.#options.signedInSubject()) === null)
          return;
        const permission = await this.#options.permissions.current();
        if (permission.granted || !permission.canAskAgain) return;
        await this.#options.permissions.request();
        await this.#sync();
      })
      .catch(async (error: unknown) => {
        this.#publishFailure(
          await this.#load(),
          clientPublicDetail(error, "This phone could not turn on notifications."),
        );
      });
  }

  async setPreferences(preferences: NotificationPreferences): Promise<void> {
    await this.#queue.run(async () => {
      const file = await this.#load();
      await this.#write({ ...file, preferences });
      await this.#sync();
    });
  }

  /**
   * Withdraws this install's registration. Call it while the Account
   * credential is still valid — afterwards there is nothing to authorize the
   * `DELETE` with, and the Account would keep sending to a phone that has
   * signed out.
   */
  async signOut(): Promise<void> {
    await this.#queue.run(async () => {
      const file = await this.#load();
      if (file.registered === null) {
        this.#publish(file, "signed-out");
        return;
      }
      await this.#options.registry.unregister(file.installationId);
      // Not a `sync`: the credential still exists at this moment, so the state
      // machine would answer "registered" and put the row straight back.
      this.#publish(await this.#write({ ...file, registered: null }), "signed-out");
    });
  }

  /** Drops the token listener. The registration itself outlives the process. */
  stop(): void {
    this.#detachToken?.();
    this.#detachToken = null;
    this.#listeners.clear();
  }

  async #sync(rolledToken?: string): Promise<void> {
    const file = await this.#load();
    if (!this.#options.accountConfigured) {
      this.#publish(file, "no-account-service");
      return;
    }
    const accountSubject = await this.#options.signedInSubject();
    if (accountSubject === null) {
      this.#publish(file, "signed-out");
      return;
    }
    const permission = await this.#options.permissions.current();
    if (!permission.granted) {
      this.#publish(file, permission.canAskAgain ? "permission-undetermined" : "permission-denied");
      return;
    }
    let desired: RegisteredDevice;
    let request: RegisterNotificationDeviceRequest;
    try {
      const apsEnvironment =
        this.#options.platform === "ios" ? await this.#options.tokens.apsEnvironment() : undefined;
      desired = RegisteredDeviceSchema.parse({
        accountSubject,
        approvalsEnabled: file.preferences.approvalsEnabled,
        platform: this.#options.platform,
        runOutcomesEnabled: file.preferences.runOutcomesEnabled,
        token: rolledToken ?? (await this.#readToken()),
      });
      this.#knownToken = desired.token;
      const fields = {
        approvalsEnabled: desired.approvalsEnabled,
        runOutcomesEnabled: desired.runOutcomesEnabled,
        token: desired.token,
      };
      request = RegisterNotificationDeviceRequestSchema.parse(
        this.#options.platform === "ios"
          ? { ...fields, platform: "ios", apsEnvironment }
          : { ...fields, platform: "android" },
      );
    } catch (error) {
      this.#publishFailure(
        file,
        clientPublicDetail(
          error,
          "This phone could not get a push token from the operating system.",
        ),
      );
      return;
    }
    try {
      await this.#options.registry.register(file.installationId, request);
    } catch (error) {
      if (error instanceof PushNotConfiguredError || error instanceof DeviceLimitReachedError) {
        // A refused replacement leaves the last confirmed row on the Account,
        // so sign-out must still withdraw it.
        this.#publish(
          file,
          error instanceof DeviceLimitReachedError ? "device-limit" : "push-not-configured",
        );
        return;
      }
      this.#publishFailure(
        file,
        clientPublicDetail(error, "This phone could not register for notifications."),
      );
      return;
    }
    const stored = await this.#write({ ...file, registered: desired });
    this.#publish(stored, "registered");
  }

  async #readToken(): Promise<string> {
    this.#readingToken = true;
    this.#announcedDuringRead = null;
    let read: string | null = null;
    try {
      read = await this.#options.tokens.current();
      return read;
    } finally {
      this.#readingToken = false;
      const announced = this.#announcedDuringRead;
      this.#announcedDuringRead = null;
      // Unlike the read's own echo, a different token is a rotation the read
      // may have missed; it registers next, without reading again.
      if (announced !== null && announced !== read) {
        void this.#queue.run(() => this.#sync(announced));
      }
    }
  }

  async #load(): Promise<PushStateFile> {
    const cached = this.#file;
    if (cached !== null) return cached;
    const stored = await this.#options.privateFiles.readFile(
      this.#options.filePath,
      maximumStateFileBytes,
    );
    const parsed =
      stored === null ? undefined : PushStateFileSchema.safeParse(decodeJson(stored)).data;
    if (parsed !== undefined) {
      this.#file = parsed;
      return parsed;
    }
    // A first launch and an unreadable file are the same situation: this
    // install has no identity yet, so it gets one. Both notification kinds
    // start on, because a person who granted the permission asked to be told.
    return this.#write({
      installationId: this.#mintInstallationId(),
      preferences: { approvalsEnabled: true, runOutcomesEnabled: true },
      registered: null,
      schemaVersion: 1,
    });
  }

  #mintInstallationId(): string {
    return NotificationInstallationIdSchema.parse(
      encodeBase64Url(this.#options.randomBytes(installationIdBytes)),
    );
  }

  async #write(file: PushStateFile): Promise<PushStateFile> {
    const parsed = PushStateFileSchema.parse(file);
    await this.#options.privateFiles.writeFileAtomic(
      this.#options.filePath,
      JSON.stringify(parsed),
    );
    this.#file = parsed;
    return parsed;
  }

  #publish(file: PushStateFile, status: Exclude<PushRegistrationStatus, "unavailable">): void {
    this.#state = { preferences: file.preferences, status };
    this.#emit();
  }

  #publishFailure(file: PushStateFile, detail: string): void {
    this.#state = { detail, preferences: file.preferences, status: "unavailable" };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
