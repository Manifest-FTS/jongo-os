const fs = require("fs");
const path = require("path");

const webRoot = path.resolve(__dirname, "..");
const staticSource = path.join(webRoot, ".next", "static");

if (!fs.existsSync(staticSource)) {
  console.error("[postbuild] Missing source static directory:", staticSource);
  process.exit(1);
}

const destinations = [
  path.join(webRoot, ".next", "standalone", "apps", "web", ".next", "static"),
  path.join(webRoot, ".next", "standalone", ".next", "static")
];

let copied = 0;
for (const destination of destinations) {
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(staticSource, destination, { recursive: true, force: true });
    copied += 1;
  } catch (error) {
    // Ignore destination layouts that are not present for this Next output shape.
  }
}

if (copied === 0) {
  console.error("[postbuild] No standalone destination accepted static assets.");
  process.exit(1);
}

console.log(`[postbuild] Copied .next/static to ${copied} standalone destination(s).`);