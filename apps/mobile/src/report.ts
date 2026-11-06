export const supportEmail = "tim@opensteer.com";
export function reportEmail(input: {
  readonly kind: "reply" | "app";
  readonly id: string;
  readonly version: string;
  readonly platform: string;
}): { subject: string; body: string } {
  return {
    subject: "Opensteer AI content report",
    body: `Please describe the problem:\n\n\nOpensteer ${input.version}\nPlatform: ${input.platform}\n${input.kind === "reply" ? "Message" : "App"}: ${input.id}`,
  };
}
