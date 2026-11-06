/** Fixed, user-safe messages keyed by a short code. Nothing from the request is ever echoed into a page. */
export const OIDC_ERROR_MESSAGES: Record<string, { title: string; message: string }> = {
  invalid_client: { title: "Sign-in link not valid", message: "This sign-in link is not valid. Return to the site and try again." },
  invalid_redirect_uri: { title: "Sign-in link not valid", message: "This sign-in link is not valid. Return to the site and try again." },
  invalid_request: { title: "Sign-in expired", message: "This approval page expired. Return to the site and sign in again." },
  no_access: { title: "No access", message: "Your Jongo account does not have access to Craft for this app. Ask an administrator of the app to grant you access." },
  rate_limited: { title: "Too many attempts", message: "Too many sign-in attempts. Wait a minute and try again." },
  unavailable: { title: "Not available", message: "Sign in with Jongo is not available right now." }
};

export function oidcErrorMessage(code: string | undefined): { title: string; message: string } {
  return (code && Object.prototype.hasOwnProperty.call(OIDC_ERROR_MESSAGES, code) ? OIDC_ERROR_MESSAGES[code] : undefined) ?? OIDC_ERROR_MESSAGES.unavailable;
}
