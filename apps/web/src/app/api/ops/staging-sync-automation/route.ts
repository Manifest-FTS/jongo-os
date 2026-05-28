import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const runtime = "nodejs";

type AutomationPayload = {
  siteId?: string;
  productionServiceUuid?: string;
  stagingServiceUuid?: string;
  stagingUrl?: string;
  mode?: string;
};

function readBearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token;
}

function resolveRemediationScriptPath(): string | null {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "scripts", "remediate-staging-content-sync.mjs"),
    path.join(cwd, "..", "scripts", "remediate-staging-content-sync.mjs"),
    path.join(cwd, "..", "..", "scripts", "remediate-staging-content-sync.mjs")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function trimTail(value: string, lines = 20): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}

function hasValue(value?: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

async function runSyncApply(scriptPath: string, payload: Required<Pick<AutomationPayload, "siteId" | "productionServiceUuid" | "stagingServiceUuid" | "stagingUrl">>) {
  const args = [
    scriptPath,
    "--apply",
    "--site-id",
    payload.siteId,
    "--prod-service-uuid",
    payload.productionServiceUuid,
    "--staging-service-uuid",
    payload.stagingServiceUuid,
    "--staging-url",
    payload.stagingUrl
  ];

  return await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, 10 * 60 * 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stderr += `\nspawn_error:${error.message}`;
      resolve({ code: null, stdout, stderr, timedOut: false });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

export async function POST(request: Request) {
  const configuredToken = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
  const providedToken = readBearerToken(request);

  if (!configuredToken || !providedToken || providedToken !== configuredToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: AutomationPayload;
  try {
    payload = (await request.json()) as AutomationPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if ((payload.mode || "apply") !== "apply") {
    return NextResponse.json({ error: "Unsupported mode" }, { status: 400 });
  }

  if (!payload.siteId || !payload.productionServiceUuid || !payload.stagingServiceUuid || !payload.stagingUrl) {
    return NextResponse.json(
      {
        error: "Missing required fields",
        required: ["siteId", "productionServiceUuid", "stagingServiceUuid", "stagingUrl"]
      },
      { status: 400 }
    );
  }

  const scriptPath = resolveRemediationScriptPath();
  if (!scriptPath) {
    return NextResponse.json({ error: "Remediation script not found" }, { status: 500 });
  }

  const hasSshHost = hasValue(process.env.STAGING_SYNC_SSH_HOST) || hasValue(process.env.COOLIFY_SSH_HOST);
  if (!hasSshHost) {
    return NextResponse.json(
      {
        ok: false,
        reason: "missing_config",
        message: "Missing STAGING_SYNC_SSH_HOST (or COOLIFY_SSH_HOST)."
      },
      { status: 412 }
    );
  }

  const result = await runSyncApply(scriptPath, {
    siteId: payload.siteId,
    productionServiceUuid: payload.productionServiceUuid,
    stagingServiceUuid: payload.stagingServiceUuid,
    stagingUrl: payload.stagingUrl
  });

  const stdoutTail = trimTail(result.stdout, 20);
  const stderrTail = trimTail(result.stderr, 20);

  if (result.timedOut) {
    return NextResponse.json(
      {
        ok: false,
        reason: "timed_out",
        message: "Automation apply timed out",
        stdoutTail,
        stderrTail
      },
      { status: 504 }
    );
  }

  if (result.code !== 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "command_failed",
        message: "Automation apply failed",
        exitCode: result.code,
        stdoutTail,
        stderrTail
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    reason: "completed",
    message: "Automation apply completed",
    exitCode: result.code,
    stdoutTail,
    stderrTail
  });
}
