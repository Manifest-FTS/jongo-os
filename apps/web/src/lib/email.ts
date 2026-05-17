import nodemailer from "nodemailer";

export type EmailResult = {
  sent: boolean;
  provider: "smtp2go" | "smtp" | "none";
  error?: string;
  messageId?: string;
};

export function isSmtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
    process.env.SMTP_PORT?.trim() &&
    process.env.SMTP_USER?.trim() &&
    process.env.SMTP_PASSWORD?.trim() &&
    process.env.SMTP_FROM?.trim()
  );
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST?.trim() ?? "";
  const port = Number.parseInt(process.env.SMTP_PORT?.trim() ?? "587", 10);
  const secure = (process.env.SMTP_TLS ?? "false").trim().toLowerCase() === "true";
  const user = process.env.SMTP_USER?.trim() ?? "";
  const pass = process.env.SMTP_PASSWORD ?? "";
  const from = process.env.SMTP_FROM?.trim() ?? "noreply@localhost";

  const provider = (process.env.SMTP_PROVIDER ?? "").trim().toLowerCase() === "smtp2go" ||
    host.toLowerCase().includes("smtp2go")
    ? "smtp2go"
    : "smtp";

  return { host, port, secure, user, pass, from, provider: provider as "smtp2go" | "smtp" };
}

export async function sendTransactionalEmail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<EmailResult> {
  if (!isSmtpConfigured()) {
    return { sent: false, provider: "none", error: "SMTP not configured" };
  }

  const config = getSmtpConfig();

  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass
      }
    });

    const info = await transporter.sendMail({
      from: config.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html
    });

    return {
      sent: true,
      provider: config.provider,
      messageId: info.messageId
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMTP error";
    return {
      sent: false,
      provider: config.provider,
      error: message
    };
  }
}

export async function sendInviteEmail(input: {
  to: string;
  inviteUrl: string;
  expiresAt: Date;
  scopeLabel: string;
  role: string;
}): Promise<EmailResult> {
  const expiry = input.expiresAt.toISOString();
  const subject = `You're invited to join ${input.scopeLabel} on Jongo`;
  const text = [
    `You have been invited to join ${input.scopeLabel} as ${input.role}.`,
    "",
    `Accept invite: ${input.inviteUrl}`,
    `Expires at: ${expiry}`,
    "",
    "If you did not expect this invite, ignore this email."
  ].join("\n");

  const html = [
    `<p>You have been invited to join <strong>${escapeHtml(input.scopeLabel)}</strong> as <strong>${escapeHtml(input.role)}</strong>.</p>`,
    `<p><a href=\"${escapeHtml(input.inviteUrl)}\">Accept invitation</a></p>`,
    `<p>Expires at: ${escapeHtml(expiry)}</p>`,
    "<p>If you did not expect this invite, ignore this email.</p>"
  ].join("");

  return sendTransactionalEmail({
    to: input.to,
    subject,
    text,
    html
  });
}

export async function sendInviteAcceptedEmail(input: {
  to: string;
  scopeLabel: string;
  acceptedByEmail: string;
}): Promise<EmailResult> {
  const subject = `Invitation accepted for ${input.scopeLabel}`;
  const text = `${input.acceptedByEmail} accepted an invitation for ${input.scopeLabel}.`;
  const html = `<p><strong>${escapeHtml(input.acceptedByEmail)}</strong> accepted an invitation for <strong>${escapeHtml(input.scopeLabel)}</strong>.</p>`;

  return sendTransactionalEmail({
    to: input.to,
    subject,
    text,
    html
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
