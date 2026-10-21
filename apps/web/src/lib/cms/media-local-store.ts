import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { MAX_MEDIA_BYTES, type CmsMediaStore } from "./media";

if (typeof window !== "undefined") throw new Error("CMS media storage is server-only.");
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const keyPattern = new RegExp(`^${uuid}/${uuid}/[0-9a-f]{64}\\.webp$`);

/** Isolated TEST adapter ONLY (NODE_ENV=test). Creates a fresh namespace under an
 * explicit absolute caller-owned directory. No route/static mapping is installed:
 * URLs are NOT publicly reachable. No deletion authority exposed.
 */
export async function createIsolatedFileSystemMediaStore(options: {
  publicBaseUrl: string; approvedOrigin: string; parentDirectory: string;
}): Promise<{ store: CmsMediaStore; root: string }> {
  if (process.env.NODE_ENV !== "test") throw new Error("Isolated media storage is a test-only adapter.");
  const origin = new URL(options.approvedOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.approvedOrigin) throw new Error("Invalid media origin.");
  const base = new URL(options.publicBaseUrl);
  if (base.origin !== origin.origin || base.href !== `${origin.origin}/assets/` || base.username || base.password) {
    throw new Error("Invalid media public base.");
  }
  if (typeof options.parentDirectory !== "string" || !isAbsolute(options.parentDirectory)) throw new Error("Explicit absolute media root required.");
  const parent = await realpath(options.parentDirectory);
  if (!(await stat(parent)).isDirectory() || parent.split(sep).some(part => part.toLowerCase() === "public")) {
    throw new Error("Invalid media root.");
  }
  const root = await mkdtemp(join(parent, "jongo-media-"));
  const path = (visibility: "private" | "public", key: string) => {
    if (typeof key !== "string" || !keyPattern.test(key)) throw new Error("Invalid media key.");
    const target = join(root, visibility, ...key.split("/"));
    const within = relative(join(root, visibility), target);
    if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Invalid media key.");
    return target;
  };
  async function read(visibility: "private" | "public", key: string): Promise<Buffer> {
    const handle = await open(path(visibility, key), "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_MEDIA_BYTES) throw new Error("Invalid media size.");
      const bytes = await handle.readFile();
      if (bytes.length !== info.size || bytes.length > MAX_MEDIA_BYTES) throw new Error("Media changed during read.");
      return bytes;
    } finally { await handle.close(); }
  }
  const store: CmsMediaStore = {
    async putPrivate(key, bytes) {
      const destination = path("private", key);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_MEDIA_BYTES ||
          key.split("/")[2] !== `${createHash("sha256").update(bytes).digest("hex")}.webp`) throw new Error("Invalid media bytes.");
      await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
      const handle = await open(destination, "wx", 0o600);
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
    },
    getPrivate: key => read("private", key),
    async promotePublic(key) {
      const destination = path("public", key);
      await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
      try { await copyFile(path("private", key), destination, constants.COPYFILE_EXCL); }
      catch (error) {
        // Transaction retries may encounter an already promoted immutable object.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await read("public", key);
        const original = await read("private", key);
        if (!existing.equals(original)) throw new Error("Public object conflict.");
      }
    },
    getPublic: key => read("public", key),
    publicUrl(key) { path("public", key); return `${base.href}${key}`; }
  };
  return { store, root };
}
