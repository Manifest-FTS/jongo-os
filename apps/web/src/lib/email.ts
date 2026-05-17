import nodemailer from "nodemailer";

export type EmailProviderMode = "disabled" | "smtp" | "smtp2go_api";

export type EmailResult = {
  sent: boolean;
  provider: "smtp" | "smtp2go_api" | "none";
  error?: string;
  messageId?: string;
};

function isGenericSmtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
    process.env.SMTP_PORT?.trim() &&
    process.env.SMTP_USER?.trim() &&
    process.env.SMTP_PASSWORD?.trim() &&
    process.env.SMTP_FROM?.trim()
  );
}

function isSmtp2GoApiConfigured(): boolean {
  return Boolean(process.env.SMTP2GO_API_KEY?.trim() && process.env.SMTP_FROM?.trim());
}

export function getEmailProviderMode(): EmailProviderMode {
  if (isSmtp2GoApiConfigured()) {
    return "smtp2go_api";
  }
  if (isGenericSmtpConfigured()) {
    return "smtp";
  }
  return "disabled";
}

export function isSmtpConfigured(): boolean {
  return getEmailProviderMode() !== "disabled";
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST?.trim() ?? "";
  const port = Number.parseInt(process.env.SMTP_PORT?.trim() ?? "587", 10);
  const secure = (process.env.SMTP_TLS ?? "false").trim().toLowerCase() === "true";
  const user = process.env.SMTP_USER?.trim() ?? "";
  const pass = process.env.SMTP_PASSWORD ?? "";
  const from = process.env.SMTP_FROM?.trim() ?? "noreply@localhost";

  return { host, port, secure, user, pass, from, provider: "smtp" as const };
}

export async function sendTransactionalEmail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<EmailResult> {
  const mode = getEmailProviderMode();
  if (mode === "disabled") {
    return { sent: false, provider: "none", error: "SMTP not configured" };
  }

  if (mode === "smtp2go_api") {
    const apiKey = process.env.SMTP2GO_API_KEY?.trim() ?? "";
    const from = process.env.SMTP_FROM?.trim() ?? "noreply@localhost";

    try {
      const response = await fetch("https://api.smtp2go.com/v3/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          to: [input.to],
          sender: from,
          subject: input.subject,
          text_body: input.text,
          html_body: input.html ?? `<p>${escapeHtml(input.text)}</p>`
        })
      });

      const payload = await response.json().catch(() => ({}));
      const requestId = typeof payload?.data?.email_id === "string"
        ? payload.data.email_id
        : typeof payload?.request_id === "string"
        ? payload.request_id
        : undefined;

      if (!response.ok || Number(payload?.data?.succeeded ?? 0) < 1) {
        const failureError = payload?.data?.failures?.[0]?.error_code;
        return {
          sent: false,
          provider: "smtp2go_api",
          error: failureError ? String(failureError) : `SMTP2GO API request failed (${response.status})`
        };
      }

      return {
        sent: true,
        provider: "smtp2go_api",
        messageId: requestId
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown SMTP2GO API error";
      return {
        sent: false,
        provider: "smtp2go_api",
        error: message
      };
    }
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
