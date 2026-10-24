/**
 * Notification & admin broadcast core (TSK-00951).
 *
 * Split from the API routes so the recipient-resolution and template logic can
 * be unit tested without a database, following the pattern already used by
 * site-notify.ts (pure helpers) + email.ts (transport).
 */

import { renderTransactionalEmail } from "./email-layout";
import { richMessageToEmailHtml, richMessageToPlainText } from "./rich-message";
import { sendTransactionalEmail } from "./email";
import { getDb } from "./db";

export type BroadcastScope = "all" | "clients" | "apps" | "members";

export type BroadcastDeliveryMode = "in_app" | "email" | "in_app_and_email";

export type BroadcastRecipientSelection = {
  scope: BroadcastScope;
  clientIds?: string[];
  siteIds?: string[];
  userIds?: string[];
};

export type ResolvedRecipient = {
  userId: string;
  email: string;
  fullName: string | null;
  clientId: string | null;
  clientName: string | null;
  appId: string | null;
  appName: string | null;
};

/** {{recipient_name}}, {{client_name}}, {{app_name}}, and action-link placeholders exposed by the composer. */
export function applyTemplateVariables(
  template: string,
  vars: { recipient_name?: string; client_name?: string; app_name?: string; action_link?: string; action_link_label?: string }
): string {
  return template.replace(/\{\{\s*(recipient_name|client_name|app_name|action_link|action_link_label)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key as keyof typeof vars];
    return value && value.trim() ? value : "";
  });
}

export type BroadcastActionLink = { label: string; url: string } | null;

/** Accept complete http(s) CTAs only; never render a partial or executable link. */
export function normalizeBroadcastActionLink(input: {
  label?: unknown;
  url?: unknown;
}): { actionLink: BroadcastActionLink; error: string | null } {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
  if (!label && !rawUrl) return { actionLink: null, error: null };
  if (!label || !rawUrl) return { actionLink: null, error: "Provide both an action link label and URL, or leave both blank." };
  if (label.length > 80) return { actionLink: null, error: "Action link label must be 80 characters or fewer." };
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported protocol");
    return { actionLink: { label, url: parsed.toString() }, error: null };
  } catch {
    return { actionLink: null, error: "Action link URL must be a valid http or https address." };
  }
}

/**
 * {{recipient_name}} greets the person; {{client_name}} names their
 * client/organization. Falls back to the client name, then the part of the
 * email before the @, so the placeholder never renders empty.
 */
export function deriveRecipientFirstName(input: { fullName: string | null; email: string; clientName: string | null }): string {
  const firstFromFullName = input.fullName?.trim().split(/\s+/)[0];
  if (firstFromFullName) return firstFromFullName;
  if (input.clientName?.trim()) return input.clientName.trim();
  return input.email.split("@")[0] ?? input.email;
}

/**
 * Every user with access to the given clients, deduplicated by userId. Mirrors
 * the owner + org-collaborator union used everywhere else access is resolved
 * (see getClientTeamMembers / resolveSitePermissionSnapshot) rather than
 * inventing a second notion of "who belongs to a client".
 */
async function resolveClientRecipients(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  clientIds: string[]
): Promise<ResolvedRecipient[]> {
  if (clientIds.length === 0) return [];

  const orgs = await db.organization.findMany({
    where: { id: { in: clientIds }, deletedAt: null },
    select: {
      id: true,
      name: true,
      owner: { select: { id: true, email: true, fullName: true } },
      collaborators: {
        where: { deletedAt: null },
        select: { user: { select: { id: true, email: true, fullName: true } } }
      }
    }
  });

  const byUser = new Map<string, ResolvedRecipient>();
  for (const org of orgs) {
    const members = [
      org.owner,
      ...org.collaborators.map((c: any) => c.user)
    ].filter((u: any): u is { id: string; email: string; fullName: string | null } => Boolean(u?.id));

    for (const member of members) {
      if (byUser.has(member.id)) continue;
      byUser.set(member.id, {
        userId: member.id,
        email: member.email,
        fullName: member.fullName,
        clientId: org.id,
        clientName: org.name,
        appId: null,
        appName: null
      });
    }
  }

  return [...byUser.values()];
}

/** Recipients for specific apps: the owning client's whole team, tagged with the app for {{app_name}}. */
async function resolveAppRecipients(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  siteIds: string[]
): Promise<ResolvedRecipient[]> {
  if (siteIds.length === 0) return [];

  const sites = await db.site.findMany({
    where: { id: { in: siteIds }, deletedAt: null },
    select: {
      id: true,
      name: true,
      organization: {
        select: {
          id: true,
          name: true,
          owner: { select: { id: true, email: true, fullName: true } },
          collaborators: {
            where: { deletedAt: null },
            select: { user: { select: { id: true, email: true, fullName: true } } }
          }
        }
      }
    }
  });

  const byUser = new Map<string, ResolvedRecipient>();
  for (const site of sites) {
    const org = site.organization;
    const members = [org.owner, ...org.collaborators.map((c: any) => c.user)].filter(
      (u: any): u is { id: string; email: string; fullName: string | null } => Boolean(u?.id)
    );

    for (const member of members) {
      // First app wins if a person has access to more than one selected app —
      // {{app_name}} names one app per notification either way.
      if (byUser.has(member.id)) continue;
      byUser.set(member.id, {
        userId: member.id,
        email: member.email,
        fullName: member.fullName,
        clientId: org.id,
        clientName: org.name,
        appId: site.id,
        appName: site.name
      });
    }
  }

  return [...byUser.values()];
}

async function resolveMemberRecipients(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userIds: string[]
): Promise<ResolvedRecipient[]> {
  if (userIds.length === 0) return [];

  const users = await db.user.findMany({
    where: { id: { in: userIds }, deletedAt: null },
    select: {
      id: true,
      email: true,
      fullName: true,
      organizations: { select: { id: true, name: true }, take: 1 }
    }
  });

  return users.map((u: any) => ({
    userId: u.id,
    email: u.email,
    fullName: u.fullName,
    clientId: u.organizations[0]?.id ?? null,
    clientName: u.organizations[0]?.name ?? null,
    appId: null,
    appName: null
  }));
}

async function resolveAllRecipients(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>
): Promise<ResolvedRecipient[]> {
  const orgs = await db.organization.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      owner: { select: { id: true, email: true, fullName: true } },
      collaborators: {
        where: { deletedAt: null },
        select: { user: { select: { id: true, email: true, fullName: true } } }
      }
    }
  });

  const byUser = new Map<string, ResolvedRecipient>();
  for (const org of orgs) {
    const members = [org.owner, ...org.collaborators.map((c: any) => c.user)].filter(
      (u: any): u is { id: string; email: string; fullName: string | null } => Boolean(u?.id)
    );
    for (const member of members) {
      if (byUser.has(member.id)) continue;
      byUser.set(member.id, {
        userId: member.id,
        email: member.email,
        fullName: member.fullName,
        clientId: org.id,
        clientName: org.name,
        appId: null,
        appName: null
      });
    }
  }
  return [...byUser.values()];
}

export async function resolveBroadcastRecipients(
  selection: BroadcastRecipientSelection
): Promise<ResolvedRecipient[]> {
  const db = await getDb();
  if (!db) return [];

  switch (selection.scope) {
    case "all":
      return resolveAllRecipients(db);
    case "clients":
      return resolveClientRecipients(db, selection.clientIds ?? []);
    case "apps":
      return resolveAppRecipients(db, selection.siteIds ?? []);
    case "members":
      return resolveMemberRecipients(db, selection.userIds ?? []);
    default:
      return [];
  }
}

const DELIVERY_MODE_TO_DB: Record<BroadcastDeliveryMode, "in_app" | "email" | "in_app_and_email"> = {
  in_app: "in_app",
  email: "email",
  in_app_and_email: "in_app_and_email"
};

/**
 * Sends one broadcast to a resolved recipient list: an in-app Notification row
 * per recipient (when the delivery mode includes it) and a branded email per
 * recipient (when it includes email AND that recipient has not opted out via
 * emailNotificationsEnabled). Never throws — a bad address or a down SMTP
 * provider must not blow up the whole send; failures are counted instead.
 */
export async function sendBroadcast(input: {
  createdBy: string;
  subject: string;
  message: string;
  templateKey?: string | null;
  deliveryMode: BroadcastDeliveryMode;
  selection: BroadcastRecipientSelection;
  actionLinkLabel?: string;
  actionLinkUrl?: string;
}): Promise<{ broadcastId: string; recipientCount: number; emailSentCount: number; emailFailedCount: number }> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database unavailable");
  }

  const recipients = await resolveBroadcastRecipients(input.selection);

  const broadcast = await db.notificationBroadcast.create({
    data: {
      createdBy: input.createdBy,
      templateKey: input.templateKey ?? null,
      subject: input.subject,
      message: input.message,
      actionLinkLabel: input.actionLinkLabel ?? null,
      actionLinkUrl: input.actionLinkUrl ?? null,
      deliveryMode: DELIVERY_MODE_TO_DB[input.deliveryMode],
      recipientScope: input.selection as any,
      recipientCount: recipients.length
    },
    select: { id: true }
  });

  const includesInApp = input.deliveryMode === "in_app" || input.deliveryMode === "in_app_and_email";
  const includesEmail = input.deliveryMode === "email" || input.deliveryMode === "in_app_and_email";

  if (includesInApp && recipients.length > 0) {
    await db.notification.createMany({
      data: recipients.map((r) => {
        const vars = {
          recipient_name: deriveRecipientFirstName(r),
          client_name: r.clientName ?? undefined,
          app_name: r.appName ?? undefined,
          action_link: input.actionLinkUrl,
          action_link_label: input.actionLinkLabel
        };
        return {
          userId: r.userId,
          clientId: r.clientId,
          appId: r.appId,
          broadcastId: broadcast.id,
          type: "general" as const,
          title: applyTemplateVariables(input.subject, vars),
          message: applyTemplateVariables(input.message, vars),
          actionLinkLabel: input.actionLinkLabel ?? null,
          actionLinkUrl: input.actionLinkUrl ?? null
        };
      })
    });
  }

  let emailSentCount = 0;
  let emailFailedCount = 0;

  if (includesEmail && recipients.length > 0) {
    const prefsByUser = await db.userProfileSettings.findMany({
      where: { userId: { in: recipients.map((r) => r.userId) } },
      select: { userId: true, emailNotificationsEnabled: true }
    });
    const optedOut = new Set(
      prefsByUser.filter((p: any) => p.emailNotificationsEnabled === false).map((p: any) => p.userId)
    );

    for (const recipient of recipients) {
      if (optedOut.has(recipient.userId)) continue;

      const vars = {
        recipient_name: deriveRecipientFirstName(recipient),
        client_name: recipient.clientName ?? undefined,
        app_name: recipient.appName ?? undefined,
        action_link: input.actionLinkUrl,
        action_link_label: input.actionLinkLabel
      };
      const subject = applyTemplateVariables(input.subject, vars);
      const body = applyTemplateVariables(input.message, vars);
      const textBody = richMessageToPlainText(body);
      const text = input.actionLinkLabel && input.actionLinkUrl
        ? `${textBody}\n\n${input.actionLinkLabel}: ${input.actionLinkUrl}`
        : textBody;

      try {
        const html = renderTransactionalEmail({
          preheader: subject,
          badge: { tone: "info", label: "Announcement" },
          title: subject,
          introHtml: richMessageToEmailHtml(body),
          cta: input.actionLinkLabel && input.actionLinkUrl
            ? { label: input.actionLinkLabel, url: input.actionLinkUrl }
            : undefined,
          footnote: ""
        });

        const result = await sendTransactionalEmail({
          to: recipient.email,
          subject,
          text,
          html
        });
        if (result.sent) emailSentCount += 1;
        else emailFailedCount += 1;
      } catch {
        emailFailedCount += 1;
      }
    }
  }

  if (includesEmail) {
    await db.notificationBroadcast.update({
      where: { id: broadcast.id },
      data: { emailSentCount, emailFailedCount }
    });
  }

  return {
    broadcastId: broadcast.id,
    recipientCount: recipients.length,
    emailSentCount,
    emailFailedCount
  };
}

/**
 * Preview-send a composed broadcast to its author alone. The recipient is
 * resolved from the authenticated user id, never from client input; test sends
 * are deliberately recorded in broadcast history and bypass email opt-out.
 */
export async function sendBroadcastTest(input: {
  createdBy: string;
  subject: string;
  message: string;
  actionLinkLabel?: string;
  actionLinkUrl?: string;
}): Promise<{ broadcastId: string; emailSentCount: number; emailFailedCount: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const recipient = await db.user.findFirst({
    where: { id: input.createdBy, deletedAt: null },
    select: { id: true, email: true, fullName: true }
  });
  if (!recipient?.email) throw new Error("Signed-in account could not be resolved");

  const broadcast = await db.notificationBroadcast.create({
    data: {
      createdBy: recipient.id,
      templateKey: "test_preview",
      subject: input.subject,
      message: input.message,
      actionLinkLabel: input.actionLinkLabel ?? null,
      actionLinkUrl: input.actionLinkUrl ?? null,
      deliveryMode: "in_app_and_email",
      recipientScope: { scope: "test", userIds: [recipient.id] },
      recipientCount: 1
    },
    select: { id: true }
  });

  const vars = { recipient_name: recipient.fullName?.trim().split(/\s+/)[0] ?? recipient.email.split("@")[0] };
  const subject = applyTemplateVariables(input.subject, vars);
  const message = applyTemplateVariables(input.message, vars);
  const textBody = richMessageToPlainText(message);
  const text = input.actionLinkLabel && input.actionLinkUrl
    ? `${textBody}\n\n${input.actionLinkLabel}: ${input.actionLinkUrl}`
    : textBody;
  await db.notification.create({
    data: {
      userId: recipient.id,
      broadcastId: broadcast.id,
      type: "general",
      title: subject,
      message,
      actionLinkLabel: input.actionLinkLabel ?? null,
      actionLinkUrl: input.actionLinkUrl ?? null
    }
  });

  let emailSentCount = 0;
  let emailFailedCount = 0;
  try {
    const result = await sendTransactionalEmail({
      to: recipient.email,
      subject,
      text,
      html: renderTransactionalEmail({
        preheader: subject,
        badge: { tone: "info", label: "Broadcast preview" },
        title: subject,
        introHtml: richMessageToEmailHtml(message),
        cta: input.actionLinkLabel && input.actionLinkUrl
          ? { label: input.actionLinkLabel, url: input.actionLinkUrl }
          : undefined,
        footnote: ""
      })
    });
    if (result.sent) emailSentCount = 1;
    else emailFailedCount = 1;
  } catch {
    emailFailedCount = 1;
  }

  await db.notificationBroadcast.update({
    where: { id: broadcast.id },
    data: { emailSentCount, emailFailedCount }
  });
  return { broadcastId: broadcast.id, emailSentCount, emailFailedCount };
}
