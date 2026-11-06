import { SUPPORTED_SCOPES } from "./config";

export function buildDiscoveryDocument(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oidc/authorize`,
    token_endpoint: `${issuer}/api/oidc/token`,
    jwks_uri: `${issuer}/api/oidc/jwks`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["EdDSA"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...SUPPORTED_SCOPES],
    claims_supported: ["iss", "sub", "aud", "exp", "iat", "auth_time", "nonce", "jti", "email", "email_verified", "name", "craft"],
    authorization_response_iss_parameter_supported: true,
    request_parameter_supported: false,
    request_uri_parameter_supported: false
  };
}
