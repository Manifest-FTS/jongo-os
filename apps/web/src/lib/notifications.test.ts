import { describe, expect, it } from "vitest";
import { applyTemplateVariables, deriveRecipientFirstName } from "./notifications";

describe("applyTemplateVariables", () => {
  it("substitutes all four supported placeholders", () => {
    const result = applyTemplateVariables(
      "Hi {{recipient_name}} at {{client_name}}, see {{app_name}}: {{action_link}}",
      {
        recipient_name: "Jane",
        client_name: "Acme",
        app_name: "acme.com",
        action_link: "https://jongo.app/clients/acme"
      }
    );
    expect(result).toBe("Hi Jane at Acme, see acme.com: https://jongo.app/clients/acme");
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
