import { describe, expect, it } from "vitest";
import { renderTransactionalEmail } from "./email-layout";

describe("transactional email shell", () => {
  it("brands the header and linked footer with the Jongo mark", () => {
    const html = renderTransactionalEmail({ preheader: "Update", title: "Update complete" });
    expect(html).toContain("Manifest FTS");
    expect(html).toContain("Jongo by Manifest FTS");
    expect(html).toContain("https://jongo.app/?utm_source=transactional_email");
    expect(html).toContain("jongo-logomark-color.png");
  });

  it("renders a trusted rich body slot and omits the access disclaimer when no footnote is passed", () => {
    const html = renderTransactionalEmail({
      preheader: "Update",
      title: "Update complete",
      introHtml: '<p style="margin:0">First paragraph</p><p>Second paragraph</p>'
    });
    expect(html).toContain("First paragraph</p><p>Second paragraph");
    expect(html).not.toContain("You are receiving this because");
  });

  it("retains accessible CTA text/link fallback", () => {
    const html = renderTransactionalEmail({
      preheader: "Read the notice",
      title: "Update complete",
      cta: { label: "Read the notice", url: "https://example.com/security" }
    });
    expect(html).toContain(">Read the notice</a>");
    expect(html).toContain("Or open this link:");
  });
});
