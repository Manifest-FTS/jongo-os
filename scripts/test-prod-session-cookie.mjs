import { encode } from "next-auth/jwt";

const secret = "2bbba0c11c00c3e6e9bd8ea834302604aaed69b4fbef185c4398d84facdca35d";
const baseToken = {
  id: "5cac6639-a30a-4a63-b732-f76e4ee21575",
  email: "devkev@manifestfts.com",
  sub: "5cac6639-a30a-4a63-b732-f76e4ee21575"
};

const pairs = [
  ["__Secure-next-auth.session-token", "__Secure-next-auth.session-token"],
  ["next-auth.session-token", "next-auth.session-token"],
  ["__Secure-authjs.session-token", "__Secure-authjs.session-token"],
  ["authjs.session-token", "authjs.session-token"],
  ["next-auth.session-token", "next-auth.jwt"]
];

for (const [cookieName, salt] of pairs) {
  const token = await encode({ secret, salt, token: baseToken, maxAge: 3600 });
  const res = await fetch("https://jongo.manifest-fts.com/api/auth/session", {
    headers: { cookie: `${cookieName}=${token}` }
  });
  const body = await res.text();
  console.log(`${cookieName} salt=${salt} => ${res.status} ${body}`);
}
