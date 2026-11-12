// Signed with the previous release’s discovery shape; keep these bytes intact.
export const previousReleaseDeploymentCatalog = {
  schemaVersion: 4,
  revision: 1,
  updatedAt: "2026-11-10T12:00:00.000Z",
  selectedDeploymentId: "dep_11111111-1111-4111-8111-111111111111",
  deployments: [
    {
      accountAccess: null,
      authority: {
        document: {
          canonicalOrigin: "http://127.0.0.1:4310",
          deploymentId: "dep_11111111-1111-4111-8111-111111111111",
          hostInstanceId: "hst_22222222-2222-4222-8222-222222222222",
          hostKey: {
            algorithm: "Ed25519",
          },
          deploymentShape: {
            defaultWorkspaceBacking: "local-directory",
            kind: "personal",
          },
        },
        publicKey: {
          algorithm: "Ed25519",
          spki: "MCowBQYDK2VwAyEAulbzM-5ylLz5m4ROSZMk4GO60f7weLQ3iXXNAAlMYxg",
        },
        signature:
          "thch3hIy5sX5vdNk4r5Y1Qkr6ItMepNr1HejbDdwKJ69llfAdjxokPuxMC6tSNJe8WVxKPcUfEgJFIF7yrlwAQ",
      },
      bootstrapMethods: [],
      kind: "personal",
      name: "Home",
      source: {
        kind: "manual",
      },
      endpoints: [
        {
          kind: "canonical",
          origin: "http://127.0.0.1:4310",
          verifiedAt: "2026-11-10T12:00:00.000Z",
        },
      ],
      reachability: "routed",
      personalAccessRoute: null,
      preferredEndpointOrigin: null,
      accountLivenessExpiresAt: null,
      createdAt: "2026-11-10T12:00:00.000Z",
      lastUsedAt: null,
      updatedAt: "2026-11-10T12:00:00.000Z",
    },
  ],
} as const;
