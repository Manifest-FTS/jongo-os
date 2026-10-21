import { validateDocument, type Reference } from "./schema";
import { cmsSchemaRegistry, type AgencyWork, type Article, type PartnerStory } from "./schemas";
import { inspectJson, isObject, isSafeUrl, type ReferenceTarget } from "./validation";

/** Public DTO v1. No source paths, raw assets, approval evidence or storage revisions. */
export type PublicImage = { src: string; alt: string; caption: string };
export type PublicAuthor = { name: string; role?: string; url?: string };
export type PublicSeo = { title: string; description: string };
export type PublicWorkProject = {
  kind: "workCaseStudy"; id: string; slug: string; name: string; category: string;
  headline: string; summary: string; services: string[]; tone: AgencyWork["tone"];
  cardImage: PublicImage; gallery: PublicImage[]; technicalSpecs: string[];
  projectUrl?: string; caseStudyUrl?: string; author?: PublicAuthor; attribution?: string;
};
export type PublicTestimonial = {
  kind: "testimonial"; id: string; slug: string; name: string; role: string; company: string;
  quote: string; portrait: string; portraitAlt: string; tone: PartnerStory["tone"];
  portraitFocalPoint?: { x: number; y: number };
  companyBadge: { kind: "text"; label: string }; logo?: PublicImage;
  badge?: { kind: "context" | "history" | "measured"; label: string; period?: string };
  partnershipBeganAt?: string; link?: { href: string; label: string };
  author?: PublicAuthor; attribution?: string;
};
/** Smaller than authoring Portable Text. Consumers must implement exactly these tokens. */
export const PUBLIC_ARTICLE_TOKENS = {
  styles: ["normal", "h2", "h3", "h4", "blockquote"],
  decorators: ["strong", "em", "code"],
  annotations: ["link"], nodes: ["block", "image"], lists: ["bullet", "number"]
} as const;
export type PublicArticleBlock = {
  _type: "block"; _key: string; style: typeof PUBLIC_ARTICLE_TOKENS.styles[number];
  listItem?: "bullet" | "number"; level?: number;
  children: { _type: "span"; _key: string; text: string; marks: string[] }[];
  markDefs: { _type: "link"; _key: string; href: string }[];
} | ({ _type: "image"; _key: string } & PublicImage);
export type PublicArticleListItem = {
  kind: "article"; id: string; slug: string; title: string; excerpt: string;
  publishedAt: string; updatedAt?: string; cover: PublicImage;
  author?: PublicAuthor; attribution?: string;
};
export type PublicArticleDetail = PublicArticleListItem & { body: PublicArticleBlock[]; seo?: PublicSeo };
export type PublicMarketingDocument = PublicWorkProject | PublicTestimonial | PublicArticleDetail;

/**
 * PRECONDITION, NOT AUTHENTICATION: an authoritative server-selected public release
 * entry, bound to the consumer's dataset/audience and selected immutable revision.
 * Never deserialize this from a request or construct it from canPublish/variant.
 * No boolean, source publication state or cryptographic claim is an authority here.
 */
export type PublishedReleaseContext = Readonly<{
  releaseId: string; datasetId: string; documentId: string; revisionId: string; schemaVersion: number;
}>;
export type ApprovedReleaseEnvelope = {
  release: PublishedReleaseContext;
  revision: Readonly<{ id: string; datasetId: string; documentId: string; schemaVersion: number; payload: unknown }>;
  /** Same-dataset reference closure selected by the server, not a client record map. */
  references: ReadonlyMap<string, ReferenceTarget>;
};
/** URL approval/storage checks belong to the server. No URL is read from a raw asset record. */
export type ApprovedAssetResolver = (reference: Readonly<Reference>, release: PublishedReleaseContext) =>
  Readonly<{ url: string; alt: string; caption: string }> | null;

export class MarketingProjectionError extends Error {
  constructor() { super("Marketing public projection unavailable."); this.name = "MarketingProjectionError"; }
}
const fail = (): never => { throw new MarketingProjectionError(); };
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const member = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && values.includes(value as T);

function publicCredits(value: { author?: PublicAuthor; attribution?: string }): { author?: PublicAuthor; attribution?: string } {
  return {
    ...(value.author ? { author: { name: value.author.name,
      ...(value.author.role !== undefined ? { role: value.author.role } : {}),
      ...(value.author.url !== undefined ? { url: value.author.url } : {}) } } : {}),
    ...(value.attribution !== undefined ? { attribution: value.attribution } : {})
  };
}
function publicSlug(value: { slug?: { current: string } }): string {
  const slug = value.slug?.current;
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return fail();
  return slug;
}
function assertRelease(value: unknown): asserts value is PublishedReleaseContext {
  if (inspectJson(value).length || !isObject(value)) return fail();
  const keys = ["releaseId", "datasetId", "documentId", "revisionId", "schemaVersion"];
  if (Object.keys(value).some(key => !keys.includes(key)) ||
    keys.slice(0, 4).some(key => !nonempty(value[key]) || String(value[key]).length > 1024) ||
    !Number.isInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) return fail();
}

/**
 * Pure projection, NOT an authorization assertion. The trusted boundary is the
 * caller's release lookup. Checks bindings/eligibility and reconstructs every
 * public property; never serialize the envelope or validateDocument().source.
 */
export function mapApprovedRelease(envelope: ApprovedReleaseEnvelope, resolveAsset: ApprovedAssetResolver): PublicMarketingDocument {
  assertRelease(envelope.release);
  const release = Object.freeze({ ...envelope.release });
  const revision = envelope.revision;
  if (!revision || revision.id !== release.revisionId || revision.datasetId !== release.datasetId ||
    revision.documentId !== release.documentId || revision.schemaVersion !== release.schemaVersion) return fail();
  // Detach before invoking callbacks, so resolver side effects cannot change source data.
  if (inspectJson(revision.payload).length) return fail();
  const payload: unknown = JSON.parse(JSON.stringify(revision.payload));
  const checked = validateDocument(payload, cmsSchemaRegistry, { mode: "publish", records: envelope.references });
  if (!checked.canPublish || !checked.value || cmsSchemaRegistry.get(checked.value._type)?.schemaVersion !== release.schemaVersion) return fail();
  const value = checked.value;

  function image(reference: Reference, alt?: string, caption?: string): PublicImage {
    if (reference._ref.startsWith("drafts.") || envelope.references.get(reference._ref)?._type !== "sanity.imageAsset") return fail();
    let rendition: ReturnType<ApprovedAssetResolver>;
    try { rendition = resolveAsset(Object.freeze({ _type: "reference", _ref: reference._ref }), release); }
    catch { return fail(); }
    if (!rendition || inspectJson(rendition).length || !isSafeUrl(rendition.url) ||
      !(rendition.url.startsWith("https://") || (rendition.url.startsWith("/") && !rendition.url.startsWith("//"))) ||
      !nonempty(alt ?? rendition.alt) || typeof (caption ?? rendition.caption) !== "string") return fail();
    return { src: rendition.url, alt: alt ?? rendition.alt, caption: caption ?? rendition.caption };
  }
  // InferDocument over the whole registry is not a distributive union. Narrow
  // only after the exact registered runtime schema has validated this payload.
  if (value._type === "agencyWork") {
    const document = value as AgencyWork;
    if (!document.cardAsset) return fail();
    return { kind: "workCaseStudy", id: document._id, slug: publicSlug(document), name: document.clientName,
      category: document.category, headline: document.headline, summary: document.detailSummary,
      services: [...document.services], tone: document.tone, cardImage: image(document.cardAsset),
      gallery: (document.gallery ?? []).map(item => image(item.asset, item.alt, item.caption)),
      technicalSpecs: [...(document.technicalSpecs ?? [])],
      ...(document.projectUrl !== undefined ? { projectUrl: document.projectUrl } : {}),
      ...(document.caseStudyUrl !== undefined ? { caseStudyUrl: document.caseStudyUrl } : {}),
      ...publicCredits(document) };
  }
  if (value._type === "partnerStories") {
    const document = value as PartnerStory;
    if (!document.portrait) return fail();
    const portrait = image(document.portrait.asset, document.portrait.alt, document.portrait.caption);
    return { kind: "testimonial", id: document._id, slug: publicSlug(document), name: document.personName,
      role: document.role, company: document.company, quote: document.excerpt ?? document.quote,
      portrait: portrait.src, portraitAlt: portrait.alt, tone: document.tone,
      ...(document.portrait.focalPoint ? { portraitFocalPoint: { x: document.portrait.focalPoint.x, y: document.portrait.focalPoint.y } } : {}),
      companyBadge: { kind: "text", label: document.textBadge ?? document.company },
      ...(document.logo ? { logo: image(document.logo) } : {}),
      ...(document.badge ? { badge: { kind: document.badge.kind, label: document.badge.label,
        ...(document.badge.period !== undefined ? { period: document.badge.period } : {}) } } : {}),
      ...(document.partnershipBeganAt !== undefined ? { partnershipBeganAt: document.partnershipBeganAt } : {}),
      ...(document.link ? { link: { href: document.link.href, label: document.link.label } } : {}),
      ...publicCredits(document) };
  }
  if (value._type !== "article") return fail();
  const document = value as Article;
  if (!document.cover || !document.publishedAt || !document.body.length) return fail();
  const body: PublicArticleBlock[] = document.body.map(value => {
    const node: Record<string, unknown> = value;
    if (node._type === "image") {
      // No caption AST/geometry fallback, embeds, groups, or reference expansion.
      if (!isObject(node.asset) || !nonempty(node.alt) || node.crop !== undefined || node.hotspot !== undefined ||
        (node.caption !== undefined && typeof node.caption !== "string")) return fail();
      return { _type: "image", _key: String(node._key), ...image(node.asset as Reference, node.alt, node.caption as string | undefined) };
    }
    if (node._type !== "block" || !member(PUBLIC_ARTICLE_TOKENS.styles, node.style ?? "normal") ||
      !Array.isArray(node.markDefs) || !Array.isArray(node.children)) return fail();
    const markDefs = node.markDefs.map(mark => {
      if (!isObject(mark) || mark._type !== "link" || typeof mark._key !== "string" || !isSafeUrl(mark.href)) return fail();
      return { _type: "link" as const, _key: mark._key, href: mark.href };
    });
    const children = node.children.map(span => {
      if (!isObject(span) || span._type !== "span" || typeof span._key !== "string" || typeof span.text !== "string" ||
        !Array.isArray(span.marks) || span.marks.some(mark => !member(PUBLIC_ARTICLE_TOKENS.decorators, mark) && !markDefs.some(def => def._key === mark))) return fail();
      return { _type: "span" as const, _key: span._key, text: span.text, marks: [...span.marks] as string[] };
    });
    return { _type: "block", _key: String(node._key), style: (node.style ?? "normal") as typeof PUBLIC_ARTICLE_TOKENS.styles[number],
      ...(node.listItem !== undefined ? { listItem: node.listItem as "bullet" | "number" } : {}),
      ...(node.level !== undefined ? { level: node.level as number } : {}), children, markDefs };
  });
  return { kind: "article", id: document._id, slug: publicSlug(document), title: document.title, excerpt: document.excerpt,
    publishedAt: document.publishedAt, ...(document.updatedAt !== undefined ? { updatedAt: document.updatedAt } : {}),
    cover: image(document.cover.asset, document.cover.alt, document.cover.caption), body,
    ...(document.seo ? { seo: { title: document.seo.title, description: document.seo.description } } : {}), ...publicCredits(document) };
}

/** Takes an already projected detail; no body/private fields are spread to lists. */
export function toPublicArticleListItem(article: PublicArticleDetail): PublicArticleListItem {
  return { kind: "article", id: article.id, slug: article.slug, title: article.title, excerpt: article.excerpt,
    publishedAt: article.publishedAt, ...(article.updatedAt !== undefined ? { updatedAt: article.updatedAt } : {}),
    cover: { src: article.cover.src, alt: article.cover.alt, caption: article.cover.caption }, ...publicCredits(article) };
}