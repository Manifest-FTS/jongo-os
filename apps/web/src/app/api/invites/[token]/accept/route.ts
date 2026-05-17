import { NextResponse } from "next/server";
import { hash, compare } from "bcryptjs";
import { auth } from "@/lib/auth.config";
import { isSmtpConfigured, sendInviteAcceptedEmail } from "@/lib/email";
import { hashInviteToken, isInviteExpired } from "@/lib/invitations";
import { normalizeRole } from "@/lib/roles";

type Params = { params: Promise<{ token: string }> };

type Body = {
  mode?: "register" | "login";
  email?: string;
  password?: string;
  fullName?: string;
};

function normalizeEmail(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

function isMissingEnumTypeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("type \"public.collaboratorrole\" does not exist") ||
    message.includes("type \"public.sitecollaboratorrole\" does not exist");
}

export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  const session = await auth();

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const { db } = await import("@/lib/db");
    const tokenHash = hashInviteToken(token);

    const invite = await db.invitation.findUnique({
      where: { tokenHash },
      include: {
        invitedBy: { select: { email: true } }
      }
    });

    if (!invite) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    if (invite.revokedAt || invite.acceptedAt || isInviteExpired(invite.expiresAt)) {
      return NextResponse.json({ error: "Invitation is no longer valid" }, { status: 410 });
    }

    const inviteEmail = normalizeEmail(invite.email);
    const requestEmail = normalizeEmail(body.email);
    let user = null as null | { id: string; email: string };

    if (session?.user?.id && normalizeEmail(session.user.email) === inviteEmail) {
      const existing = await db.user.findUnique({
        where: { id: session.user.id },
        select: { id: true, email: true }
      });
      if (existing) {
        user = existing;
      }
    }

    if (!user) {
      const mode = body.mode;
      const password = body.password ?? "";
      const fullName = body.fullName?.trim() || inviteEmail.split("@")[0];

      if (requestEmail !== inviteEmail) {
        return NextResponse.json({ error: "Invite email does not match." }, { status: 400 });
      }

      if (mode === "register") {
        if (password.length < 8) {
          return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
        }

        const existingUser = await db.user.findUnique({ where: { email: inviteEmail } });
        if (existingUser) {
          return NextResponse.json({ error: "Account already exists. Please use login to accept invite." }, { status: 409 });
        }

        const passwordHash = await hash(password, 12);
        const created = await db.user.create({
          data: {
            email: inviteEmail,
            fullName,
            passwordHash,
            emailVerified: false,
            authProvider: "local"
          },
          select: { id: true, email: true }
        });
        user = created;
      } else if (mode === "login") {
        const existingUser = await db.user.findUnique({ where: { email: inviteEmail } });
        if (!existingUser?.passwordHash) {
          return NextResponse.json({ error: "No local password account found for this email." }, { status: 404 });
        }

        const valid = await compare(password, existingUser.passwordHash);
        if (!valid) {
          return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
        }

        user = { id: existingUser.id, email: existingUser.email };
      } else {
        return NextResponse.json({ error: "mode must be register or login" }, { status: 400 });
      }
    }

    if (!user) {
      return NextResponse.json({ error: "Unable to resolve user for invite acceptance." }, { status: 400 });
    }

    const role = normalizeRole(invite.role);

    const accepted = await db.$transaction(async (tx: any) => {
      const fresh = await tx.invitation.findUnique({ where: { id: invite.id } });
      if (!fresh || fresh.acceptedAt || fresh.revokedAt || isInviteExpired(fresh.expiresAt)) {
        throw new Error("INVITE_INVALID");
      }

      if (fresh.inviteType === "organization") {
        try {
          await tx.collaborator.upsert({
            where: {
              organizationId_userId: {
                organizationId: fresh.organizationId,
                userId: user!.id
              }
            },
            update: { role },
            create: {
              organizationId: fresh.organizationId,
              userId: user!.id,
              role,
              grantedById: fresh.invitedById
            }
          });
        } catch (error) {
          if (!isMissingEnumTypeError(error)) {
            throw error;
          }

          await tx.$executeRawUnsafe(
            `
              INSERT INTO "Collaborator" (
                "organizationId", "userId", "role", "grantedById", "grantedAt", "createdAt", "updatedAt"
              )
              VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
              ON CONFLICT ("organizationId", "userId")
              DO UPDATE SET "role" = EXCLUDED."role", "updatedAt" = NOW()
            `,
            fresh.organizationId,
            user!.id,
            role,
            fresh.invitedById
          );
        }
      }

      if (fresh.inviteType === "site") {
        if (!fresh.siteId) {
          throw new Error("INVITE_INVALID");
        }

        try {
          await tx.siteCollaborator.upsert({
            where: {
              siteId_userId: {
                siteId: fresh.siteId,
                userId: user!.id
              }
            },
            update: { role },
            create: {
              siteId: fresh.siteId,
              userId: user!.id,
              role
            }
          });
        } catch (error) {
          if (!isMissingEnumTypeError(error)) {
            throw error;
          }

          await tx.$executeRawUnsafe(
            `
              INSERT INTO "SiteCollaborator" (
                "siteId", "userId", "role", "createdAt", "updatedAt"
              )
              VALUES ($1, $2, $3, NOW(), NOW())
              ON CONFLICT ("siteId", "userId")
              DO UPDATE SET "role" = EXCLUDED."role", "updatedAt" = NOW()
            `,
            fresh.siteId,
            user!.id,
            role
          );
        }
      }

      return tx.invitation.update({
        where: { id: fresh.id },
        data: {
          acceptedAt: new Date(),
          acceptedByUserId: user!.id
        }
      });
    });

    if (isSmtpConfigured() && invite.invitedBy?.email) {
      const scopeLabel = invite.inviteType === "site" ? "site team" : "client team";
      void sendInviteAcceptedEmail({
        to: invite.invitedBy.email,
        scopeLabel,
        acceptedByEmail: user.email
      });
    }

    return NextResponse.json({
      ok: true,
      acceptedAt: accepted.acceptedAt,
      email: user.email,
      role,
      inviteType: invite.inviteType
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVITE_INVALID") {
      return NextResponse.json({ error: "Invitation is no longer valid" }, { status: 410 });
    }

    console.error("POST /api/invites/[token]/accept error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
