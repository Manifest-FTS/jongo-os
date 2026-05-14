export type RuntimeConfigStatus = {
  databaseConfigured: boolean;
  nextauthSecretConfigured: boolean;
  coolifyBaseUrlConfigured: boolean;
  coolifyTokenConfigured: boolean;
  coolifyMode: "live" | "mock";
};

export function getRuntimeConfigStatus(): RuntimeConfigStatus {
  const coolifyBaseUrlConfigured = Boolean(process.env.COOLIFY_API_BASE_URL);
  const coolifyTokenConfigured = Boolean(process.env.COOLIFY_API_TOKEN);

  return {
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    nextauthSecretConfigured: Boolean(process.env.NEXTAUTH_SECRET),
    coolifyBaseUrlConfigured,
    coolifyTokenConfigured,
    coolifyMode: coolifyBaseUrlConfigured && coolifyTokenConfigured ? "live" : "mock"
  };
}