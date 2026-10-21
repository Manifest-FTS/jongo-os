import { PUBLIC_ARTICLE_TOKENS } from "./marketing-contracts";

// Dependency-free JSON Schema 2020-12. additionalProperties:false at every object
// boundary makes consumer transport validation an allowlist, not private stripping.
const string = { type: "string" } as const;
const text = { type: "string", minLength: 1 } as const;
const slug = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } as const;
const timestamp = { type: "string", format: "date-time" } as const;
const url = { type: "string", maxLength: 4096, pattern: "^(https?://|/[^/]|#[a-zA-Z0-9_-])" } as const;
const assetUrl = { type: "string", maxLength: 4096, pattern: "^(https://|/[^/])" } as const;
type Shape = Record<string, unknown>;
const object = (properties: Shape, required: readonly string[]) => ({ type: "object", additionalProperties: false, properties, required });
const array = (items: Shape) => ({ type: "array", items });
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const imageFields = { src: assetUrl, alt: text, caption: string };
const credits = { author: ref("Author"), attribution: string };
const articleFields = {
  kind: { const: "article" }, id: text, slug, title: text, excerpt: text,
  publishedAt: timestamp, updatedAt: timestamp, cover: ref("Image"), ...credits
};
const articleRequired = ["kind", "id", "slug", "title", "excerpt", "publishedAt", "cover"];

/** Serialize this object for a future delivery SDK; it contains no authoring descriptors. */
export const marketingDtoJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Jongo marketing public DTO v1",
  oneOf: [ref("WorkProject"), ref("Testimonial"), ref("ArticleDetail")],
  $defs: {
    Image: object(imageFields, ["src", "alt", "caption"]),
    Author: object({ name: text, role: string, url }, ["name"]),
    Seo: object({ title: text, description: text }, ["title", "description"]),
    WorkProject: object({
      kind: { const: "workCaseStudy" }, id: text, slug, name: text, category: text,
      headline: text, summary: text, services: array(text), tone: { enum: ["sage", "blush", "sand"] },
      cardImage: ref("Image"), gallery: array(ref("Image")), technicalSpecs: array(text),
      projectUrl: url, caseStudyUrl: url, ...credits
    }, ["kind", "id", "slug", "name", "category", "headline", "summary", "services", "tone", "cardImage", "gallery", "technicalSpecs"]),
    Testimonial: object({
      kind: { const: "testimonial" }, id: text, slug, name: text, role: text, company: text,
      quote: text, portrait: assetUrl, portraitAlt: text, tone: { enum: ["charcoal", "lime", "blue", "neutral"] },
      portraitFocalPoint: object({ x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } }, ["x", "y"]),
      companyBadge: object({ kind: { const: "text" }, label: text }, ["kind", "label"]), logo: ref("Image"),
      badge: object({ kind: { enum: ["context", "history", "measured"] }, label: text, period: string }, ["kind", "label"]),
      partnershipBeganAt: { type: "string", format: "date" },
      link: object({ href: url, label: text }, ["href", "label"]), ...credits
    }, ["kind", "id", "slug", "name", "role", "company", "quote", "portrait", "portraitAlt", "tone", "companyBadge"]),
    ArticleListItem: object(articleFields, articleRequired),
    ArticleDetail: object({ ...articleFields, body: { ...array(ref("ArticleBlock")), minItems: 1 }, seo: ref("Seo") }, [...articleRequired, "body"]),
    ArticleBlock: { oneOf: [ref("TextBlock"), ref("ImageBlock")] },
    TextBlock: object({
      _type: { const: "block" }, _key: text, style: { enum: PUBLIC_ARTICLE_TOKENS.styles },
      listItem: { enum: PUBLIC_ARTICLE_TOKENS.lists }, level: { type: "integer", minimum: 1, maximum: 10 },
      children: array(ref("Span")), markDefs: array(ref("Link"))
    }, ["_type", "_key", "style", "children", "markDefs"]),
    Span: object({ _type: { const: "span" }, _key: text, text: string, marks: array(text) }, ["_type", "_key", "text", "marks"]),
    Link: object({ _type: { const: "link" }, _key: text, href: url }, ["_type", "_key", "href"]),
    ImageBlock: object({ _type: { const: "image" }, _key: text, ...imageFields }, ["_type", "_key", "src", "alt", "caption"])
  }
} as const;