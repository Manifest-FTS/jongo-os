import { describe, expect, it } from "vitest";
import { applyTemplateVariables, deriveRecipientFirstName, normalizeBroadcastActionLink } from "./notifications";
import { richMessageToEmailHtml, richMessageToPlainText } from "./rich-message";

describe("applyTemplateVariables", () => {
  it("substitutes recipient, client, app, and labeled action-link placeholders", () => {
    const result = applyTemplateVariables(
      "Hi {{recipient_name}} at {{client_name}}, see {{app_name}}: {{action_link_label}} {{action_link}}",
      {
        recipient_name: "Jane",
        client_name: "Acme",
        app_name: "acme.com",
        action_link: "https://jongo.app/clients/acme",
        action_link_label: "View app"
      }
    );
    expect(result).toBe("Hi Jane at Acme, see acme.com: View app https://jongo.app/clients/acme");
  });

  it("drops a placeholder to an empty string when no value is supplied", () => {
    expect(applyTemplateVariables("Hi {{recipient_name}}!", {})).toBe("Hi !");
  });

  it("leaves unrelated braces alone", () => {
    expect(applyTemplateVariables("Use {{not_a_var}} literally", { client_name: "Acme" })).toBe(
      "Use {{not_a_var}} literally"
    );
  });

  it("substitutes repeated placeholders", () => {
    expect(applyTemplateVariables("{{client_name}} / {{client_name}}", { client_name: "Acme" })).toBe("Acme / Acme");
  });

  it("substitutes inline action URLs before safe rich-message rendering", () => {
    const body = applyTemplateVariables("Read {{action_link}}", { action_link: "https://example.com/security" });
    expect(richMessageToEmailHtml(body)).toContain('href="https://example.com/security"');
    expect(richMessageToPlainText(body)).toContain("https://example.com/security");
  });
});

describe("normalizeBroadcastActionLink", () => {
  it("accepts a complete http(s) link and trims the label", () => {
    expect(normalizeBroadcastActionLink({ label: " Read notice ", url: "https://example.com/security" })).toEqual({
      actionLink: { label: "Read notice", url: "https://example.com/security" },
      error: null
    });
  });

  it("allows the action link to be omitted", () => {
    expect(normalizeBroadcastActionLink({})).toEqual({ actionLink: null, error: null });
  });

  it("requires a label and URL together", () => {
    expect(normalizeBroadcastActionLink({ label: "Read notice" }).error).toMatch(/both/i);
    expect(normalizeBroadcastActionLink({ url: "https://example.com" }).error).toMatch(/both/i);
  });

  it("rejects unsafe protocols, malformed URLs, and overlong labels", () => {
    expect(normalizeBroadcastActionLink({ label: "Open", url: "javascript:alert(1)" }).error).toMatch(/http or https/i);
    expect(normalizeBroadcastActionLink({ label: "Open", url: "not a url" }).error).toMatch(/http or https/i);
    expect(normalizeBroadcastActionLink({ label: "x".repeat(81), url: "https://example.com" }).error).toMatch(/80 characters/i);
  });
});

describe("deriveRecipientFirstName", () => {
  it("takes the first token of the full name", () => {
    expect(deriveRecipientFirstName({ fullName: "Jane Smith", email: "jane@acme.com", clientName: "Acme" })).toBe("Jane");
  });

  it("falls back to the client name when there is no full name", () => {
    expect(deriveRecipientFirstName({ fullName: null, email: "jane@acme.com", clientName: "Acme" })).toBe("Acme");
  });

  it("falls back to the email local part when neither name is available", () => {
    expect(deriveRecipientFirstName({ fullName: null, email: "jane@acme.com", clientName: null })).toBe("jane");
  });

  it("ignores a blank full name", () => {
    expect(deriveRecipientFirstName({ fullName: "   ", email: "jane@acme.com", clientName: "Acme" })).toBe("Acme");
  });
});
