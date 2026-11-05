/**
 * Small hand-written conformance sample for GROQ semantics (operators, null handling, slices,
 * ordering, functions, projections, `->`). Expected values follow the GROQ specification's
 * semantics; this is NOT the groq-test-suite and not a compatibility certification.
 */
import { describe, expect, it } from "vitest";
import { runGroq, type CmsQueryDocument } from "./groq";
import { createSchemaRegistry } from "../schema";

const registry = createSchemaRegistry([]);
const ref = (_ref: string) => ({ _type: "reference", _ref });
const stamp = { _rev: "r", _createdAt: "2026-01-01T00:00:00Z", _updatedAt: "2026-01-01T00:00:00Z" };
const documents: CmsQueryDocument[] = [
  { _id: "m1", _type: "movie", ...stamp, title: "Alien", releaseYear: 1979, genres: ["Horror", "Sci-Fi"], castMembers: [{ person: ref("p1") }, { person: ref("p2") }] },
  { _id: "m2", _type: "movie", ...stamp, title: "Blade Runner", releaseYear: 1982, genres: ["Sci-Fi"], castMembers: [{ person: ref("p3") }] },
  { _id: "m3", _type: "movie", ...stamp, title: "Heat", releaseYear: 1995, genres: ["Crime"] },
  { _id: "p1", _type: "person", ...stamp, name: "Sigourney Weaver" },
  { _id: "p2", _type: "person", ...stamp, name: "Tom Skerritt" },
  { _id: "p3", _type: "person", ...stamp, name: "Harrison Ford" }
];

const cases: Array<[string, string, unknown, Record<string, unknown>?]> = [
  ["filter by type", '*[_type == "movie"].title', ["Alien", "Blade Runner", "Heat"]],
  ["comparison and &&", '*[_type == "movie" && releaseYear >= 1982].title', ["Blade Runner", "Heat"]],
  ["count", 'count(*[_type == "person"])', 3],
  ["in operator on arrays", '*[_type == "movie" && "Sci-Fi" in genres].title', ["Alien", "Blade Runner"]],
  ["order desc then index", '*[_type == "movie"] | order(releaseYear desc)[0].title', "Heat"],
  ["inclusive slice ..", '*[_type == "movie"][1..2].title', ["Blade Runner", "Heat"]],
  ["exclusive slice ...", '*[_type == "movie"][1...2].title', ["Blade Runner"]],
  ["negative index", '*[_type == "movie"][-1].title', "Heat"],
  ["projection with dereference", '*[_id == "m1"][0]{title, "cast": castMembers[].person->name}',
    { title: "Alien", cast: ["Sigourney Weaver", "Tom Skerritt"] }],
  ["missing attribute is null; missing array coalesces", '*[_id == "m3"][0]{title, "cast": coalesce(castMembers[].person->name, [])}', { title: "Heat", cast: [] }],
  ["select with fallback", '*[_type == "movie"] | order(releaseYear){"d": select(releaseYear < 1980 => "70s", releaseYear < 1990 => "80s", "later")}.d', ["70s", "80s", "later"]],
  ["arithmetic and null propagation", '{"a": 1 + "a", "b": "a" + "b", "c": 5 / 2, "d": 2 ** 10, "e": 7 % 3}', { a: null, b: "ab", c: 2.5, d: 1024, e: 1 }],
  ["defined / coalesce", '{"x": defined(*[0].nothing), "y": coalesce(null, "fallback")}', { x: false, y: "fallback" }],
  ["math::sum", 'math::sum(*[_type == "movie"].releaseYear)', 5956],
  ["text match wildcard is case-insensitive", '*[_type == "movie" && title match "ali*"].title', ["Alien"]],
  ["array::unique + order", 'array::unique(*[_type == "movie"].genres[]) | order(@)', ["Crime", "Horror", "Sci-Fi"]],
  ["string functions", '{"l": lower("ABC"), "s": string::startsWith("Alien", "Ali"), "len": length("héllo")}', { l: "abc", s: true, len: 5 }],
  ["parameters", '*[_type == "person" && name in $names].name | order(@)', ["Harrison Ford", "Tom Skerritt"], { names: ["Tom Skerritt", "Harrison Ford"] }],
  ["references()", '*[_type == "movie" && references($id)].title', ["Alien"], { id: "p2" }],
  ["parent scope ^", '*[_id == "p3"][0]{name, "films": *[_type == "movie" && references(^._id)].title}', { name: "Harrison Ford", films: ["Blade Runner"] }]
];

describe("GROQ conformance sample (groq-js)", () => {
  it.each(cases)("%s", async (_name, query, expected, params) => {
    const out = await runGroq({ documents, query, params, registry, consumer: "editor", perspective: "raw" });
    expect(out.result).toEqual(expected);
  });
});
