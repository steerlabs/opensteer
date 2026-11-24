export declare const nodeTrustVariable: "NODE_USE_SYSTEM_CA";
export declare const nodeTrustSetting: "OPENSTEER_SYSTEM_CERTIFICATES";
export declare const nodeTrustInputs: readonly string[];
export declare const homeServicePackages: readonly string[];
export declare function nodeTrustEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly environmentInputs: "drop" | "keep";
    readonly settings?: Readonly<Record<string, string | undefined>>;
  },
): Record<string, string>;
