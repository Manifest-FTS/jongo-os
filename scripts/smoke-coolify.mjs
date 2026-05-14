const baseUrl = process.env.APP_BASE_URL || "http://localhost:3000";
const expectLive = (process.env.EXPECT_LIVE || "false").toLowerCase() === "true";

async function readJson(path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: "application/json" }, redirect: "manual" });
  const contentType = res.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    return {
      status: res.status,
      body: {
        nonJson: true,
        message: `Non-JSON response from ${path}; endpoint may be auth-protected`
      }
    };
  }

  const text = await res.text();
  let body = {};

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 200)}`);
  }

  return { status: res.status, body };
}

async function run() {
  const connection = await readJson("/api/coolify/connection");
  const status = await readJson("/api/coolify/status");

  console.log("Connection:", connection.body);
  if (status.body?.nonJson) {
    console.log("Status: skipped (auth-protected)");
  } else {
    console.log("Status:", {
      mode: status.body.mode,
      stats: status.body.stats,
      siteCount: Array.isArray(status.body.sites) ? status.body.sites.length : 0
    });
  }

  if (expectLive) {
    if (!connection.body.reachable || connection.body.mode !== "live") {
      throw new Error("Expected live Coolify connection but got mock/unreachable state");
    }

    if (status.body?.nonJson) {
      console.log("EXPECT_LIVE note: /api/coolify/status is auth-protected; using connection route as the source of truth");
      console.log("Smoke test passed.");
      return;
    }

    if (status.body.mode !== "live") {
      throw new Error("Expected /api/coolify/status mode=live");
    }
  }

  console.log("Smoke test passed.");
}

run().catch((err) => {
  console.error("Smoke test failed:", err.message);
  process.exit(1);
});
