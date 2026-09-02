import { headers } from "next/headers";

function displayDomain(value: string | null): string {
  const fallback = value?.split(":")[0].trim().toLowerCase() || "this domain";
  return /^[a-z0-9-]+\.mfts\.link$/.test(fallback) ? fallback : "this domain";
}

export default async function ParkedDomainPage({
  searchParams
}: {
  searchParams: Promise<{ domain?: string }>;
}) {
  const params = await searchParams;
  const requestHeaders = await headers();
  const domain = displayDomain(params.domain ?? requestHeaders.get("host"));

  return (
    <main className="jongo-parking-page">
      <section className="jongo-parking-content" aria-labelledby="parking-title">
        <img
          className="jongo-parking-mark"
          src="/assets/images/jongo-logomark-color.png"
          alt="Jongo"
        />
        <p className="jongo-parking-eyebrow">Jongo domain parking</p>
        <h1 id="parking-title">A brand new domain.</h1>
        <p className="jongo-parking-domain">{domain}</p>
        <p className="jongo-parking-copy">
          This domain is connected and waiting for its site to arrive.
        </p>
        <a className="jongo-parking-link" href="https://jongo.app">
          Build your site with Jongo
        </a>
      </section>
      <footer className="jongo-parking-footer">
        Brought to you by Jongo. Powered by{" "}
        <a href="https://manifestfts.com" target="_blank" rel="noreferrer">
          Manifest FTS
        </a>
      </footer>
    </main>
  );
}