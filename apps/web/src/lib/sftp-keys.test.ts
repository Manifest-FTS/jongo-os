import { describe, expect, it } from "vitest";
import { buildSftpUserPayload, checkSshPublicKey, sftpSupportedFor, sshFingerprint } from "./sftp-provision";
import { generateDeployKeyPair } from "./deploy-keys";

describe("SFTP SSH keys", () => {
  const pair = generateDeployKeyPair("jay@laptop");

  it("accepts a real public key and gives the OpenSSH fingerprint", () => {
    const checked = checkSshPublicKey(`  ${pair.publicKey}  `);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.type).toBe("ssh-ed25519");
    expect(checked.comment).toBe("jay@laptop");
    expect(checked.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(checked.fingerprint).toBe(sshFingerprint(pair.publicKey.split(" ")[1]));
  });

  it("refuses a private key pasted by mistake", () => {
    const checked = checkSshPublicKey(pair.privateKey);
    expect(checked).toMatchObject({ ok: false });
    expect(!checked.ok && checked.message).toMatch(/private key/i);
  });

  it("refuses junk and a key whose blob names another type", () => {
    expect(checkSshPublicKey("hello world").ok).toBe(false);
    const blob = pair.publicKey.split(" ")[1];
    expect(checkSshPublicKey(`ssh-rsa ${blob}`).ok).toBe(false);
    expect(checkSshPublicKey("ssh-ed25519 AAAA").ok).toBe(false);
  });

  it("strips anything odd from the comment", () => {
    const blob = pair.publicKey.split(" ")[1];
    const checked = checkSshPublicKey(`ssh-ed25519 ${blob} me<script>`);
    expect(checked.ok && checked.key).toBe(`ssh-ed25519 ${blob} mescript`);
  });

  it("sends the keys to the SFTP service with the password", () => {
    const payload = buildSftpUserPayload({ username: "u", password: "p", homePath: "/srv/volumes/x_wordpress-files/_data", publicKeys: [pair.publicKey] });
    expect(payload.public_keys).toEqual([pair.publicKey]);
    expect(buildSftpUserPayload({ username: "u", password: "p", homePath: "/h" }).public_keys).toEqual([]);
  });

  it("is offered on WordPress apps only", () => {
    expect(sftpSupportedFor({ siteType: "wordpress" })).toBe(true);
    expect(sftpSupportedFor({ resourceType: "WordPress" })).toBe(true);
    expect(sftpSupportedFor({ siteType: "service" })).toBe(false);
  });
});
