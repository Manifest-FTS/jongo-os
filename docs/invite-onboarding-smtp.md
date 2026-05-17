# Invite Onboarding + SMTP Delivery

This document describes invite-token onboarding and minimal SMTP transactional delivery.

## What this enables

- Invite users to app/client teams even when they do not yet have an account
- Generate secure invite links with expiry and single-use enforcement
- Accept invite via login or account creation on invite-only route
- Keep open self-registration disabled (`ENABLE_SELF_REGISTRATION=false`)
- Optional SMTP delivery for invite emails (manual copy flow remains available)
- Admin/dev test email endpoint

## Required invite environment variables

- `INVITE_TTL_DAYS`: invite lifetime in days (default `7`)
- `INVITE_BASE_URL`: optional absolute base URL for invite links (defaults to `NEXTAUTH_URL`)
- `INVITE_TOKEN_SECRET`: optional token hash pepper (defaults to `NEXTAUTH_SECRET`)

## SMTP2GO configuration

If SMTP vars are configured, invite emails are sent automatically.

Required:
- `SMTP_HOST` (for SMTP2GO, typically `mail.smtp2go.com`)
- `SMTP_PORT` (usually `2525`, `587`, or `465`)
- `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`

Optional:
- `SMTP_TLS` (`true`/`false`)
- `SMTP_PROVIDER=smtp2go`

Behavior:
- SMTP configured: API returns pending invite and sends invite email
- SMTP missing: API returns pending invite with manual copy link guidance

## Invite acceptance endpoints

- `GET /api/invites/[token]`: validate token and read invite metadata
- `POST /api/invites/[token]/accept`: accept via `mode=register` or `mode=login`

Accepted invite behavior:
- single-use (`acceptedAt` set)
- cannot reuse expired/accepted/revoked tokens
- membership is assigned to intended app/team or client/team scope

## Admin/dev test email

- Endpoint: `POST /api/admin/email/test`
- Access: authenticated admin/dev runtime users only
- Body: `{ "to": "recipient@example.com" }` (optional, defaults to current user email)

## Security notes

- Invite tokens are never stored in plaintext (hashed before persistence)
- Secrets (`SMTP_PASSWORD`, token secrets) are never exposed to UI
- Tokens are only returned at creation time for manual copy fallback
