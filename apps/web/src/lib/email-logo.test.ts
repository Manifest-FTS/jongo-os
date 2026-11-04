import { describe, expect, it } from "vitest";
import { EMAIL_LOGO_SRC, inlineImagesFor } from "./email-logo";
import { renderTransactionalEmail } from "./email-layout";

describe("email logo", () => {
  it("is embedded in the message (cid), never loaded from a server", () => {
    expect(EMAIL_LOGO_SRC).toBe("cid:jongo-logomark.png");
  });

  it("attaches the logo only to emails that use it", () => {
    const images = inlineImagesFor(`<img src="${EMAIL_LOGO_SRC}">`);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ cid: "jongo-logomark.png", filename: "jongo-logomark.png", contentType: "image/png" });
    expect(Buffer.from(images[0].base64, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(inlineImagesFor("<p>plain</p>")).toEqual([]);
    expect(inlineImagesFor(undefined)).toEqual([]);
  });

  it("is what the branded layout uses", () => {
    const html = renderTransactionalEmail({ preheader: "p", title: "t" } as never);
    expect(html).toContain(EMAIL_LOGO_SRC);
    expect(html).not.toMatch(/<img[^>]+src="https?:/i);
  });
});
