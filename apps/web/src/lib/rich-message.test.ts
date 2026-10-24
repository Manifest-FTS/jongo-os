import { describe, expect, it } from "vitest";
import { richMessageToEmailHtml, richMessageToPlainText } from "./rich-message";

describe("rich notification message", () => {
  it("preserves paragraph and line breaks in safe email markup", () => {
    const html = richMessageToEmailHtml("First line\ncontinued\n\nSecond paragraph");
    expect(html).toContain("First line<br>continued");
    expect(html).toContain("Second paragraph");
    expect(html.match(/<p /g)).toHaveLength(2);
  });

  it("supports emphasis and Markdown links", () => {
    const html = richMessageToEmailHtml("**Important** and *emphasis* [read](https://example.com)");
    expect(html).toContain("<strong>Important</strong>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain('href="https://example.com/"');
  });

  it("escapes raw HTML and rejects unsafe link protocols", () => {
    const html = richMessageToEmailHtml('<img src=x onerror="alert(1)"> [bad](javascript:alert(1))');
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
  });

  it("produces text alternatives with paragraph spacing and visible link URLs", () => {
    expect(richMessageToPlainText("First\n\n[Read](https://example.com)")).toBe(
      "First\n\nRead (https://example.com/)"
    );
  });
});
