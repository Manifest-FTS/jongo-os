import { describe, expect, it } from "vitest";
import { applyTemplateVariables } from "./notifications";

describe("applyTemplateVariables", () => {
  it("substitutes all three supported placeholders", () => {
    const result = applyTemplateVariables("Hi {{client_name}}, see {{app_name}}: {{action_link}}", {
      client_name: "Acme",
      app_name: "acme.com",
      action_link: "https://jongo.app/clients/acme"
    });
    expect(result).toBe("Hi Acme, see acme.com: https://jongo.app/clients/acme");
  });

  it("drops a placeholder to an empty string when no value is supplied", () => {
    expect(applyTemplateVariables("Hi {{client_name}}!", {})).toBe("Hi !");
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
