import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

/**
 * /robots.txt
 *
 * The public marketing pages are open to every crawler; the app itself (behind
 * sign-in anyway), the API and internal pages are not.
 *
 * AI crawlers get their own group, allowed the same pages, so assistants
 * (ChatGPT, Claude, Perplexity, Gemini, Apple, Copilot via Bing) can read and
 * cite Jongo's plans and prices. A crawler that matches a named group ignores
 * the "*" group entirely, so the disallow list is repeated there on purpose.
 * To stop model TRAINING while staying visible in AI search, move GPTBot,
 * ClaudeBot, Google-Extended, Applebot-Extended and CCBot into a group with
 * `disallow: "/"`; the *-SearchBot and *-User agents are the ones that cite.
 */

const PRIVATE_PATHS = [
  "/api/",
  "/auth/",
  "/dashboard",
  "/clients",
  "/apps",
  "/sites",
  "/usage",
  "/my-domains",
  "/settings",
  "/notifications",
  "/style-guide",
  "/parked"
];

const AI_CRAWLERS = [
  // OpenAI
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  // Anthropic
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  // Perplexity
  "PerplexityBot",
  "Perplexity-User",
  // Google Gemini / AI Overviews training control, Apple Intelligence
  "Google-Extended",
  "Applebot-Extended",
  // Others that power assistants and answer engines
  "Amazonbot",
  "meta-externalagent",
  "DuckAssistBot",
  "MistralAI-User",
  "CCBot"
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
      { userAgent: AI_CRAWLERS, allow: ["/", "/llms.txt", "/llms-full.txt"], disallow: PRIVATE_PATHS }
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL
  };
}
