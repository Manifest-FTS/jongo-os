const fs = require("fs");
const path = require("path");

// Force bind to all interfaces so reverse proxies can reach the app container.
process.env.HOSTNAME = "0.0.0.0";
process.env.PORT = process.env.PORT || "3000";

const candidates = [
  path.join(__dirname, "..", ".next", "standalone", "apps", "web", "server.js"),
  path.join(__dirname, "..", ".next", "standalone", "server.js")
];

const serverPath = candidates.find((candidate) => fs.existsSync(candidate));

if (!serverPath) {
  console.error("[startup] Could not find Next standalone server output.");
  process.exit(1);
}

require(serverPath);
