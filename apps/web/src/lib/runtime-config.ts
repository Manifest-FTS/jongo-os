import { getEmailProviderMode } from "@/lib/email";

export type RuntimeConfigStatus = {
  databaseConfigured: boolean;
  nextauthSecretConfigured: boolean;
  coolifyBaseUrlConfigured: boolean;
  coolifyTokenConfigured: boolean;
  coolifyMode: "live" | "mock";
  emailProviderMode: "disabled" | "smtp" | "smtp2go_api";
  emailConfigured: boolean;
  smtpConfigured: boolean;
  smtp2goApiConfigured: boolean;
  emailFromConfigured: boolean;
};

export function getRuntimeConfigStatus(): RuntimeConfigStatus {
  const coolifyBaseUrlConfigured = Boolean(process.env.COOLIFY_API_BASE_URL);
  const coolifyTokenConfigured = Boolean(process.env.COOLIFY_API_TOKEN);
  const emailProviderMode = getEmailProviderMode();

  return {
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    nextauthSecretConfigured: Boolean(process.env.NEXTAUTH_SECRET),
    coolifyBaseUrlConfigured,
    coolifyTokenConfigured,
    coolifyMode: coolifyBaseUrlConfigured && coolifyTokenConfigured ? "live" : "mock",
    emailProviderMode,
    emailConfigured: emailProviderMode !== "disabled",
    smtpConfigured: Boolean(
      process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASSWORD &&
      process.env.SMTP_FROM
    ),
    smtp2goApiConfigured: Boolean(process.env.SMTP2GO_API_KEY && process.env.SMTP_FROM),
    emailFromConfigured: Boolean(process.env.SMTP_FROM)
  };
}