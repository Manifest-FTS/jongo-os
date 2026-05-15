const fs = require("fs");
const path = require("path");

const webRoot = path.resolve(__dirname, "..");
const staticSource = path.join(webRoot, ".next", "static");
const publicSource = path.join(webRoot, "public");

if (!fs.existsSync(staticSource)) {
  console.error("[postbuild] Missing source static directory:", staticSource);
  process.exit(1);
}

// Copy .next/static into the standalone output so Next's JS/CSS bundles are served.
const staticDestinations = [
  path.join(webRoot, ".next", "standalone", "apps", "web", ".next", "static"),
  path.join(webRoot, ".next", "standalone", ".next", "static")
];

let staticCopied = 0;
for (const destination of staticDestinations) {
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(staticSource, destination, { recursive: true, force: true });
    staticCopied += 1;
  } catch (error) {
    // Ignore destination layouts that are not present for this Next output shape.
  }
}

if (staticCopied === 0) {
  console.error("[postbuild] No standalone destination accepted static assets.");
  process.exit(1);
}

console.log(`[postbuild] Copied .next/static to ${staticCopied} standalone destination(s).`);

// Copy public/ into the standalone output so logos, favicon, and other public
// assets are reachable at runtime. The standalone server resolves public/ relative
// to the server.js location inside the standalone bundle.
const publicDestinations = [
  path.join(webRoot, ".next", "standalone", "apps", "web", "public"),
  path.join(webRoot, ".next", "standalone", "public")
];

let publicCopied = 0;
if (fs.existsSync(publicSource)) {
  for (const destination of publicDestinations) {
    try {
      fs.mkdirSync(destination, { recursive: true });
      fs.cpSync(publicSource, destination, { recursive: true, force: true });
      publicCopied += 1;
    } catch (error) {
      // Ignore destination layouts that are not present for this Next output shape.
    }
  }
  console.log(`[postbuild] Copied public/ to ${publicCopied} standalone destination(s).`);
} else {
  console.warn("[postbuild] No public/ directory found; skipping public asset copy.");
}