import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SiteCollaboratorManager from "./SiteCollaboratorManager";

// Vitest compiles tsx with the classic runtime (tsconfig keeps jsx: preserve for Next).
(globalThis as { React?: unknown }).React = React;

const SITE = "11111111-1111-4111-8111-111111111111";

describe("SiteCollaboratorManager", () => {
  it("flag-off markup is byte-identical to the pre-Craft component (committed snapshot)", () => {
    expect(renderToStaticMarkup(<SiteCollaboratorManager siteId={SITE} currentUserId="u" />)).toMatchSnapshot();
  });
});
