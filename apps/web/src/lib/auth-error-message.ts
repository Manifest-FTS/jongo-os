export function getCredentialSignInErrorMessage(errorCode?: string | null): string {
  if (!errorCode || errorCode === "CredentialsSignin") {
    return "Invalid email or password.";
  }

  if (errorCode === "AUTH_DB_UNAVAILABLE") {
    return "Sign-in is temporarily unavailable. Please try again in a few moments.";
  }

  if (errorCode === "AUTH_UNEXPECTED_ERROR" || errorCode === "CallbackRouteError") {
    return "Sign-in failed due to a temporary server issue. Please try again.";
  }

  return "Sign-in failed. Please try again.";
}