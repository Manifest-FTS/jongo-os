import { createSchemaRegistry, defineArrayMember, defineField, defineType, type InferDocument } from "./schema";

const text = { type: "string", minLength: 1, maxLength: 300 } as const;
const longText = { type: "text", minLength: 1, maxLength: 5000 } as const;
const stringList = { type: "array", of: [{ type: "string", minLength: 1, maxLength: 300 }], maxItems: 50 } as const;
const approvalFields = [
  { name: "status", type: "enum", options: ["pending", "approved", "denied"], required: true },
  { name: "evidence", ...longText, publishRequired: true, private: true },
  { name: "reviewer", ...text, publishRequired: true, private: true },
  { name: "approvedAt", type: "datetime", publishRequired: true, private: true }
] as const;
const provenance = defineField({ name: "provenance", type: "object", private: true, publishRequired: true, fields: [
  { name: "source", ...longText, required: true },
  { name: "attribution", ...longText },
  { name: "sourceUrl", type: "url" }
] });
const publicationApproval = defineField({ name: "publicationApproval", type: "object", fields: approvalFields, private: true, publishRequired: true });
const slug = defineField({ name: "slug", type: "slug" });
const locale = defineField({ name: "locale", ...text });
const order = defineField({ name: "order", type: "number", integer: true, min: 0, max: 100000 });
const image = defineArrayMember({ type: "object", objectType: "mediaImage", fields: [
  { name: "asset", type: "asset", to: ["sanity.imageAsset"], required: true },
  { name: "alt", ...text, required: true },
  { name: "caption", ...longText },
  { name: "focalPoint", type: "object", fields: [
    { name: "x", type: "number", min: 0, max: 1, required: true },
    { name: "y", type: "number", min: 0, max: 1, required: true }
  ] }
] });
const seo = defineField({ name: "seo", type: "object", fields: [
  { name: "title", ...text, maxLength: 100, required: true },
  { name: "description", ...longText, maxLength: 300, required: true }
] });
/** Optional, sourced public credits. Never synthesize people or copy private provenance. */
const author = defineField({ name: "author", type: "object", fields: [
  { name: "name", ...text, required: true },
  { name: "role", ...text },
  { name: "url", type: "url" }
] });
const attribution = defineField({ name: "attribution", ...longText });

export const agencyWork = defineType({
  name: "agencyWork", type: "document", schemaVersion: 1, title: "Work case studies",
  fields: [slug, locale,
    { name: "clientName", ...text, required: true },
    { name: "category", ...text, required: true },
    { name: "tone", type: "enum", options: ["sage", "blush", "sand"], required: true },
    { name: "cardAsset", type: "asset", to: ["sanity.imageAsset"], publishRequired: true },
    { name: "gallery", type: "array", of: [image], keyed: true, maxItems: 50 },
    { name: "services", ...stringList, required: true, minItems: 1 },
    { name: "headline", ...text, required: true },
    { name: "detailSummary", ...longText, required: true, maxLength: 1000 },
    { name: "technicalSpecs", ...stringList },
    { name: "projectUrl", type: "url" },
    { name: "caseStudyUrl", type: "url" },
    author, attribution, order, provenance, publicationApproval
  ], rules: ["workSummary", "publicationApproval"]
});
/** Import alias only: the persisted type remains agencyWork. */
export const workCaseStudy = agencyWork;

export const partnerStories = defineType({
  name: "partnerStories", type: "document", schemaVersion: 1, title: "Testimonials & partner stories",
  fields: [slug, locale,
    { name: "company", ...text, required: true },
    { name: "personName", ...text, required: true },
    { name: "role", ...text, required: true },
    { name: "logo", type: "asset", to: ["sanity.imageAsset"] },
    { name: "logoVerified", type: "boolean" },
    { name: "textBadge", ...text },
    { name: "portrait", type: "object", objectType: image.objectType, fields: image.fields, publishRequired: true },
    { name: "quote", ...longText, required: true },
    { name: "excerpt", ...longText },
    { name: "omissionMarker", type: "enum", options: ["…", "[…]"] },
    { name: "tone", type: "enum", options: ["charcoal", "lime", "blue", "neutral"], required: true },
    { name: "badge", type: "object", fields: [
      { name: "kind", type: "enum", options: ["context", "history", "measured"], required: true },
      { name: "label", ...text, required: true },
      { name: "source", ...longText, required: true },
      { name: "period", ...text, publishRequired: true }
    ] },
    { name: "partnershipBeganAt", type: "date" },
    { name: "relatedWork", type: "reference", to: ["agencyWork"] },
    { name: "relatedWorkVerified", type: "boolean" },
    { name: "link", type: "object", fields: [
      { name: "href", type: "url", required: true },
      { name: "label", ...text, required: true }
    ] },
    { name: "consent", type: "object", private: true, publishRequired: true, fields: [
      ...approvalFields,
      { name: "quote", type: "boolean", required: true },
      { name: "likeness", type: "boolean", required: true },
      { name: "mark", type: "boolean" }
    ] },
    author, attribution, order, provenance
  ], rules: ["partnerConsent"]
});
/** Import alias only: the persisted type remains partnerStories. */
export const testimonial = partnerStories;

export const article = defineType({
  name: "article", type: "document", schemaVersion: 1, title: "Articles",
  fields: [{ ...slug, required: true }, locale,
    { name: "title", ...text, required: true },
    { name: "excerpt", ...longText, maxLength: 1000, required: true },
    { name: "body", type: "portableText", required: true },
    author, attribution,
    { name: "publishedAt", type: "datetime", publishRequired: true },
    { name: "updatedAt", type: "datetime" },
    { name: "cover", type: "object", objectType: image.objectType, fields: image.fields, publishRequired: true },
    seo, provenance, publicationApproval
  ], rules: ["publicationApproval"]
});

export const LANDING_BLOCK_TOKENS = ["hero", "valueProps", "features", "media", "workRefs", "storyRefs", "pricingRef", "faq", "cta"] as const;
const sectionVersion = { name: "version", type: "number", min: 1, max: 1, integer: true, required: true } as const;
const sectionTone = { name: "tone", type: "enum", options: ["neutral", "charcoal", "lime", "blue", "magenta"] } as const;
const offerId = { name: "offerId", ...text, required: true } as const;
/** Offer identifiers only. Catalog/fulfillment resolution remains a separate server responsibility. */
export const landingSections = [
  defineArrayMember({ type: "object", objectType: "hero", fields: [sectionVersion, sectionTone, { name: "headline", ...text, required: true }, { name: "body", ...longText }] }),
  defineArrayMember({ type: "object", objectType: "valueProps", fields: [sectionVersion, sectionTone, { name: "items", ...stringList, required: true, minItems: 1 }] }),
  defineArrayMember({ type: "object", objectType: "features", fields: [sectionVersion, sectionTone, { name: "body", type: "portableText", required: true }] }),
  defineArrayMember({ type: "object", objectType: "media", fields: [sectionVersion, sectionTone, { name: "images", type: "array", of: [image], keyed: true, required: true, minItems: 1, maxItems: 20 }] }),
  defineArrayMember({ type: "object", objectType: "workRefs", fields: [sectionVersion, sectionTone, { name: "items", type: "array", of: [{ type: "reference", to: ["agencyWork"] }], keyed: true, required: true, maxItems: 20 }] }),
  defineArrayMember({ type: "object", objectType: "storyRefs", fields: [sectionVersion, sectionTone, { name: "items", type: "array", of: [{ type: "reference", to: ["partnerStories"] }], keyed: true, required: true, maxItems: 20 }] }),
  defineArrayMember({ type: "object", objectType: "pricingRef", fields: [sectionVersion, sectionTone, offerId] }),
  defineArrayMember({ type: "object", objectType: "faq", fields: [sectionVersion, sectionTone, { name: "items", type: "array", keyed: true, required: true, minItems: 1, maxItems: 30, of: [{ type: "object", objectType: "faqItem", fields: [{ name: "question", ...text, required: true }, { name: "answer", ...longText, required: true }] }] }] }),
  defineArrayMember({ type: "object", objectType: "cta", fields: [sectionVersion, sectionTone, { name: "label", ...text, required: true }, { name: "href", type: "url", required: true }, offerId] })
] as const;
export const productLanding = defineType({
  name: "productLanding", type: "document", schemaVersion: 1, title: "Product landing",
  fields: [slug, locale, { name: "product", type: "enum", options: ["jongo", "signal"], required: true }, seo,
    { name: "sections", type: "array", of: landingSections, keyed: true, minItems: 1, maxItems: 50, required: true },
    provenance, publicationApproval
  ], rules: ["publicationApproval"]
});

export const signalCaseStudy = defineType({
  name: "signalCaseStudy", type: "document", schemaVersion: 1, title: "Signal case study",
  fields: [slug, locale,
    { name: "title", ...text, required: true },
    { name: "summary", ...longText, required: true },
    { name: "scenario", ...longText, required: true },
    { name: "methodology", ...longText, required: true },
    { name: "services", ...stringList, required: true, minItems: 1 },
    { name: "disclosure", type: "enum", options: ["illustrative", "verified"], required: true },
    { name: "customerApproval", type: "object", private: true, fields: approvalFields, publishRequired: true },
    { name: "findings", type: "array", keyed: true, required: true, minItems: 1, maxItems: 50, of: [{ type: "object", objectType: "finding", fields: [
      { name: "statement", ...longText, required: true },
      { name: "source", ...longText, required: true },
      { name: "evidenceWindow", ...text, required: true },
      { name: "classification", type: "enum", options: ["illustrative", "verified"], required: true }
    ] }] },
    { name: "metricEvidence", type: "array", keyed: true, maxItems: 30, of: [{ type: "object", objectType: "metricEvidence", fields: [
      { name: "label", ...text, required: true }, { name: "value", type: "number", required: true },
      { name: "unit", ...text, required: true }, { name: "source", ...longText, required: true }, { name: "evidenceWindow", ...text, required: true }
    ] }] },
    { name: "images", type: "array", of: [image], keyed: true, maxItems: 30 },
    { name: "ctaOfferId", ...text }, seo, provenance
  ], rules: ["signalEvidence"]
});

export const languageDictionary = defineType({
  name: "languageDictionary", type: "document", schemaVersion: 1, title: "Language dictionary",
  fields: [
    { name: "audience", type: "enum", options: ["common", "manifest", "jongo", "signal"], required: true },
    { name: "locale", ...text, required: true },
    { name: "version", type: "number", min: 1, integer: true, required: true },
    { name: "entries", type: "array", keyed: true, maxItems: 1000, required: true, of: [{ type: "object", objectType: "dictionaryEntry", fields: [
      { name: "key", ...text, required: true },
      { name: "value", type: "text", maxLength: 5000, required: true },
      { name: "description", ...longText },
      { name: "placeholders", ...stringList, required: true },
      { name: "format", type: "enum", options: ["plain", "icu"], required: true },
      { name: "status", type: "enum", options: ["draft", "approved"], required: true },
      { name: "revision", ...text, required: true }
    ] }] }
  ], rules: ["dictionaryEntries"]
});

export const cmsSchemas = [agencyWork, partnerStories, productLanding, signalCaseStudy, languageDictionary, article] as const;
export const cmsSchemaRegistry = createSchemaRegistry(cmsSchemas);
export type AgencyWork = InferDocument<typeof agencyWork>;
export type PartnerStory = InferDocument<typeof partnerStories>;
export type WorkCaseStudy = AgencyWork;
export type Testimonial = PartnerStory;
export type Article = InferDocument<typeof article>;
export type ProductLanding = InferDocument<typeof productLanding>;
export type SignalCaseStudy = InferDocument<typeof signalCaseStudy>;
export type LanguageDictionary = InferDocument<typeof languageDictionary>;