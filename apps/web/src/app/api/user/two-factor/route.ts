import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { AUTH_RATE_LIMITS, hitRateLimit, tooManyAttemptsMessage } from "@/lib/auth-rate-limit";
import { sendSecurityChangeEmail } from "@/lib/email";
import { qrSvg } from "@/lib/totp-qr";
import {
  TWO_FACTOR_SELECT,
  confirmTwoFactorSetup,
  disableTwoFactor,
  isTwoFactorEnabled,
  replaceRecoveryCodes,
  spendSecondFactor,
  startTwoFactorSetup
} from "@/lib/two-factor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Two-step sign-in for the signed-in account.
 *
 *   GET  — { enabled, enabledAt, recoveryCodesLeft, available }
 *   POST — { action: "start" }                 new secret + QR code (pending)
 *          { action: "confirm", code }         turn on; returns recovery codes once
 *          { action: "disable", code }         turn off (needs a code)
 *          { action: "recovery-codes", code }  replace recovery codes (needs a code)
 *
 * Only for accounts that sign in with a Jongo password: an account that signs
 * in through another provider sets this up there.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function settingsUrl(): string {
  return `${process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? ""}/settings?tab=security`;
}

async function notify(to: string, change: Parameters<typeof sendSecurityChangeEmail>[0]["change"]) {
  try {
    await sendSecurityChangeEmail({ to, change, settingsUrl: settingsUrl() });
  } catch (error) {
    console.error("[two-factor] security email failed", error);
  }
}

async function load() {
  const session = await auth();
  if (!session?.user?.id) return { error: json({ ok: false, message: "Sign in first." }, 401) } as const;
  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db) return { error: json({ ok: false, message: "This isn't available right now. Please try again shortly." }, 503) } as const;
  const user = await (db as any).user.findUnique({ where: { id: session.user.id }, select: TWO_FACTOR_SELECT });
  if (!user) return { error: json({ ok: false, message: "Sign in first." }, 401) } as const;
  return { db, user } as const;
}

function usesJongoPassword(user: { passwordHash?: string | null; authProvider?: string | null }): boolean {
  return Boolean(user.passwordHash) && (!user.authProvider || user.authProvider === "local");
}

function describe(user: any) {
  return {
    ok: true,
    available: usesJongoPassword(user),
    enabled: isTwoFactorEnabled(user),
    enabledAt: user.totpEnabledAt ?? null,
    recoveryCodesLeft: isTwoFactorEnabled(user) ? (user.totpRecoveryCodes ?? []).length : 0
  };
}

export async function GET() {
  const loaded = await load();
  if ("error" in loaded) return loaded.error;
  return json(describe(loaded.user));
}

export async function POST(request: Request) {
  const loaded = await load();
  if ("error" in loaded) return loaded.error;
  const { db, user } = loaded;

  const body = (await request.json().catch(() => ({}))) as { action?: unknown; code?: unknown };
  const action = typeof body.action === "string" ? body.action : "";

  if (!usesJongoPassword(user)) {
    return json({ ok: false, message: "Your account signs in through another provider. Set up two-step sign-in there." }, 400);
  }

  if (["confirm", "disable", "recovery-codes"].includes(action)) {
    const limited = await hitRateLimit(AUTH_RATE_LIMITS.twoFactorPerUser, user.id);
    if (!limited.allowed) {
      return NextResponse.json(
        { ok: false, message: tooManyAttemptsMessage(limited.retryAfterSeconds) },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfterSeconds) } }
      );
    }
  }

  if (action === "start") {
    if (isTwoFactorEnabled(user)) return json({ ok: false, message: "Two-step sign-in is already on." }, 409);
    try {
      const setup = await startTwoFactorSetup(db, user);
      return json({ ok: true, secret: setup.secret, uri: setup.uri, qrSvg: qrSvg(setup.uri) });
    } catch (error) {
      console.error("[two-factor] could not start setup", error);
      return json({ ok: false, message: "Two-step sign-in can't be set up right now. Please try again later." }, 503);
    }
  }

  if (action === "confirm") {
    if (isTwoFactorEnabled(user)) return json({ ok: false, message: "Two-step sign-in is already on." }, 409);
    const result = await confirmTwoFactorSetup(db, user, body.code);
    if (!result.ok) {
      const message = {
        no_setup: "Start the setup again.",
        expired: "This setup took too long. Start again to get a new code.",
        invalid_code: "That code didn't match. Check the time on your phone is right and enter the newest code."
      }[result.reason];
      return json({ ok: false, reason: result.reason, message }, 400);
    }
    await notify(user.email, "two_factor_on");
    return json({ ok: true, enabled: true, recoveryCodes: result.recoveryCodes });
  }

  if (action === "disable" || action === "recovery-codes") {
    if (!isTwoFactorEnabled(user)) return json({ ok: false, message: "Two-step sign-in is off." }, 409);
    const check = await spendSecondFactor(db, user, body.code);
    if (!check.ok) {
      return json({ ok: false, reason: "invalid_code", message: "That code didn't work. Enter the newest code from your app, or a recovery code." }, 400);
    }
    if (action === "disable") {
      await disableTwoFactor(db, user.id);
      await notify(user.email, "two_factor_off");
      return json({ ok: true, enabled: false });
    }
    const codes = await replaceRecoveryCodes(db, user.id);
    await notify(user.email, "recovery_codes_replaced");
    return json({ ok: true, recoveryCodes: codes });
  }

  return json({ ok: false, message: "Unknown action." }, 400);
}
