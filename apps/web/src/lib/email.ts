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
  const expiry = input.expiresAt.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
  const subject = `You're invited to join ${input.scopeLabel} on Jongo`;
  const text = [
    "Jongo Team Invitation",
    "",
    `You have been invited to join ${input.scopeLabel} as ${input.role}.`,
    "",
    `Accept invite: ${input.inviteUrl}`,
    `Expires at: ${expiry}`,
    "",
    "If you did not expect this invite, ignore this email."
  ].join("\n");

  const html = [
    "<div style=\"margin:0;padding:24px;background:#f3f8ef;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;\">",
    "  <table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" width=\"100%\" style=\"max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #d8e3d4;border-radius:16px;overflow:hidden;\">",
    "    <tr>",
    "      <td style=\"padding:18px 22px;background:linear-gradient(120deg,#eef8e6 0%,#fff6f0 55%,#f3f9ff 100%);border-bottom:1px solid #e2ece4;\">",
    "        <div style=\"font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#4b6352;font-weight:700;\">Manifest FTS</div>",
    "        <div style=\"margin-top:4px;font-size:22px;line-height:1.2;color:#102a1d;font-weight:800;\">Jongo</div>",
    "      </td>",
    "    </tr>",
    "    <tr>",
    "      <td style=\"padding:24px 22px 12px;\">",
    `        <h1 style=\"margin:0 0 10px;font-size:22px;line-height:1.25;color:#102a1d;\">You are invited to join ${escapeHtml(input.scopeLabel)}</h1>`,
    `        <p style=\"margin:0 0 16px;font-size:14px;line-height:1.5;color:#425466;\">Your access level is <strong style=\"color:#173f2d;\">${escapeHtml(input.role)}</strong>.</p>`,
    `        <a href=\"${escapeHtml(input.inviteUrl)}\" style=\"display:inline-block;padding:12px 18px;border-radius:10px;background:#1f6f4a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;\">Accept invitation</a>`,
    "      </td>",
    "    </tr>",
    "    <tr>",
    "      <td style=\"padding:14px 22px 20px;\">",
    `        <p style=\"margin:0 0 8px;font-size:12px;color:#5f6f66;\">Expires: ${escapeHtml(expiry)}</p>`,
    `        <p style=\"margin:0 0 10px;font-size:12px;color:#5f6f66;word-break:break-all;\">Invite URL: ${escapeHtml(input.inviteUrl)}</p>`,
    "        <p style=\"margin:0;font-size:12px;color:#7b8794;\">If you did not expect this invite, you can safely ignore this email.</p>",
    "      </td>",
    "    </tr>",
    "  </table>",
    "</div>"
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

export async function sendPasswordResetEmail(input: {
  to: string;
  resetUrl: string;
  expiresAt: Date;
}): Promise<EmailResult> {
  const expiry = input.expiresAt.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
  const subject = "Reset your Jongo password";
  const text = [
    "You requested a password reset for your Jongo account.",
    "",
    `Reset your password: ${input.resetUrl}`,
    `This link expires at: ${expiry}`,
    "",
    "If you did not request this, you can safely ignore this email. Your password will not change."
  ].join("\n");

  const html = [
    "<p>You requested a password reset for your Jongo account.</p>",
    `<p><a href="${escapeHtml(input.resetUrl)}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:4px;font-weight:600;">Reset password</a></p>`,
    `<p>Or copy this link: <code>${escapeHtml(input.resetUrl)}</code></p>`,
    `<p style="color:#6b7280;font-size:0.9em;">This link expires at ${escapeHtml(expiry)}.</p>`,
    `<p style="color:#6b7280;font-size:0.9em;">If you did not request this, you can safely ignore this email.</p>`
  ].join("");

  return sendTransactionalEmail({ to: input.to, subject, text, html });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
