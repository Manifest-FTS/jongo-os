/** Fixed, user-safe messages keyed by a short code. Nothing from the request is ever echoed into a page. */
export type OidcErrorIcon = "link" | "clock" | "shield" | "lock" | "pause";
export type OidcErrorMessage = { title: string; message: string; next: string; icon: OidcErrorIcon };

export const OIDC_ERROR_MESSAGES: Record<string, OidcErrorMessage> = {
  invalid_client: { title: "Sign-in link not valid", message: "Jongo did not recognize this sign-in link.", next: "Return to the site and sign in again.", icon: "link" },
  invalid_redirect_uri: { title: "Sign-in link not valid", message: "Jongo did not recognize this sign-in link.", next: "Return to the site and sign in again.", icon: "link" },
  invalid_request: { title: "Sign-in expired", message: "This approval page expired or was changed, so it can no longer be used.", next: "Return to the site and sign in again.", icon: "clock" },
  origin: { title: "Request not accepted", message: "This request did not come from jongo.app.", next: "Open the sign-in page again from the site and try once more.", icon: "shield" },
  no_access: { title: "No access", message: "Your Jongo account does not have access to Jongo Craft for this app.", next: "Ask an administrator of the app to grant you access.", icon: "lock" },
  rate_limited: { title: "Too many attempts", message: "There were too many sign-in attempts in a short time.", next: "Wait a minute, then return to the site and try again.", icon: "pause" },
  unavailable: { title: "Not available", message: "Sign in with Jongo is not available right now.", next: "Try again in a little while.", icon: "pause" }
};

export function oidcErrorMessage(code: string | undefined): OidcErrorMessage {
  return (code && Object.prototype.hasOwnProperty.call(OIDC_ERROR_MESSAGES, code) ? OIDC_ERROR_MESSAGES[code] : undefined) ?? OIDC_ERROR_MESSAGES.unavailable;
}
