/**
 * The registrant on a domain. Pure.
 *
 * The client is the registrant (the legal owner of the name), not Jongo; WHOIS
 * privacy hides the details publicly. Namecheap requires the same set of fields
 * for four roles, and rejects the whole order over one bad field, so the form is
 * checked here first with a message per field.
 */

export type RegistrantContact = {
  firstName: string;
  lastName: string;
  organization?: string;
  address1: string;
  address2?: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country: string;
  /** Any common format; normalised to Namecheap's +CC.NUMBER. */
  phone: string;
  email: string;
};

export const CONTACT_FIELDS: Array<keyof RegistrantContact> = [
  "firstName",
  "lastName",
  "organization",
  "address1",
  "address2",
  "city",
  "stateProvince",
  "postalCode",
  "country",
  "phone",
  "email"
];

const REQUIRED: Array<keyof RegistrantContact> = [
  "firstName",
  "lastName",
  "address1",
  "city",
  "stateProvince",
  "postalCode",
  "country",
  "phone",
  "email"
];

/**
 * "+1 (555) 123-4567" -> "+1.5551234567". Needs the country code; without one
 * we would be guessing, and a wrong guess fails the registration after payment.
 * A number with no "+" is accepted only for US/CA, where the code is 1.
 */
export function normalizePhone(raw: string, country: string): string | null {
  const trimmed = String(raw ?? "").trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    // Dotted already (+44.2071234567): keep the split as given.
    const dotted = trimmed.match(/^\+(\d{1,3})\.(\d{4,14})$/);
    if (dotted) return `+${dotted[1]}.${dotted[2]}`;
    if (digits.length < 8 || digits.length > 15) return null;
    if (digits.startsWith("1")) return `+1.${digits.slice(1)}`;
    // Other countries: the code length varies (1-3 digits) and cannot be told
    // from the digits alone, so ask for the dotted form.
    return null;
  }
  const cc = country.trim().toUpperCase();
  if ((cc === "US" || cc === "CA") && (digits.length === 10 || (digits.length === 11 && digits.startsWith("1")))) {
    return `+1.${digits.slice(-10)}`;
  }
  return null;
}

export type ContactValidation =
  | { ok: true; contact: RegistrantContact }
  | { ok: false; errors: Partial<Record<keyof RegistrantContact, string>> };

export function validateContact(input: unknown): ContactValidation {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const value = (key: keyof RegistrantContact) => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");
  const errors: Partial<Record<keyof RegistrantContact, string>> = {};

  for (const key of REQUIRED) {
    if (!value(key)) errors[key] = "Required.";
  }
  for (const key of CONTACT_FIELDS) {
    if (value(key).length > 120) errors[key] = "Too long.";
  }

  const country = value("country").toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) errors.country = "Use the two-letter country code, like US.";

  const email = value("email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Enter a valid email address.";

  const phone = value("phone") ? normalizePhone(value("phone"), country) : null;
  if (value("phone") && !phone) {
    errors.phone = "Include the country code, like +1 555 123 4567 or +44.2071234567.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    contact: {
      firstName: value("firstName"),
      lastName: value("lastName"),
      ...(value("organization") ? { organization: value("organization") } : {}),
      address1: value("address1"),
      ...(value("address2") ? { address2: value("address2") } : {}),
      city: value("city"),
      stateProvince: value("stateProvince"),
      postalCode: value("postalCode"),
      country,
      phone: phone as string,
      email
    }
  };
}

const ROLES = ["Registrant", "Tech", "Admin", "AuxBilling"] as const;

/** The same contact for all four roles, in Namecheap's parameter names. */
export function toNamecheapContactParams(contact: RegistrantContact): Record<string, string> {
  const params: Record<string, string> = {};
  for (const role of ROLES) {
    params[`${role}FirstName`] = contact.firstName;
    params[`${role}LastName`] = contact.lastName;
    if (contact.organization) params[`${role}OrganizationName`] = contact.organization;
    params[`${role}Address1`] = contact.address1;
    if (contact.address2) params[`${role}Address2`] = contact.address2;
    params[`${role}City`] = contact.city;
    params[`${role}StateProvince`] = contact.stateProvince;
    params[`${role}PostalCode`] = contact.postalCode;
    params[`${role}Country`] = contact.country;
    params[`${role}Phone`] = contact.phone;
    params[`${role}EmailAddress`] = contact.email;
  }
  return params;
}
