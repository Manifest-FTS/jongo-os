import { buildLlmsFullTxt } from "@/lib/llms-txt";

// /llms-full.txt for AI assistants (https://llmstxt.org). Built from the plan data
// the pricing page renders; regenerated daily.
export const dynamic = "force-static";
export const revalidate = 86400;

export function GET() {
  return new Response(buildLlmsFullTxt(), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=86400"
    }
  });
}
