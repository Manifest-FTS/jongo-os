// Moved to lib/secret-box.ts (shared with the GitHub App secrets). Same key, so
// everything encrypted before still decrypts.
export { decryptSecret, encryptSecret } from "./secret-box";
