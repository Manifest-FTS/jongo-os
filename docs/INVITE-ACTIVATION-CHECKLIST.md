# Invite Feature Activation Checklist

**Status**: Feature code deployed ✅, database migration pending ❌  
**Target**: `https://jongo.manifest-fts.com` (production jongo-os)  
**Date**: 2026-05-17

## 🔴 BLOCKING ISSUE

**Migration `0005_invitation_tokens` is NOT applied to the production database.**

This prevents all invite functionality from working despite code being deployed.

### Immediate Fix (< 5 minutes)

```bash
# SSH to Coolify host
ssh root@coolify.manifest-fts.com

# Enter the running jongo-os app container
docker exec -it dt0v391xre5rgtp50062tunm-002216038801 bash

# Run migration deployment
cd /app && npm run db:migrate:deploy

# Expected output:
# Prisma schema loaded...
# Applying migration `0005_invitation_tokens`
# ✔ Migration `0005_invitation_tokens` applied successfully
```

**After migration succeeds**, the Invitation table will exist and invite endpoints will be functional.

---

## SMTP Email Configuration (Optional)

Jongo OS supports optional transactional email for invites using SMTP (not SMTP2GO API keys).

### Where to Set Variables
**Important**: These are APP-level environment variables, not Coolify global settings.

**In Coolify UI**:
1. Go to: `https://coolify.manifest-fts.com`
2. Select Application: `jongo.manifest-fts.com` (uuid: `dt0v391xre5rgtp50062tunm`)
3. Go to: Settings → Environment Variables
4. Add these variables:

### Variable Names & Descriptions

| Variable | Required? | Example/Notes |
|----------|-----------|--------------|
| `SMTP_HOST` | Yes (if email wanted) | `mail.smtp2go.com` or `smtp.gmail.com` |
| `SMTP_PORT` | Yes (if email wanted) | `587` (TLS) or `465` (SSL) or `2525` (SMTP2GO) |
| `SMTP_USER` | Yes (if email wanted) | Your SMTP username or API user |
| `SMTP_PASSWORD` | Yes (if email wanted) | Your SMTP password (secret, never log this) |
| `SMTP_FROM` | Yes (if email wanted) | `noreply@yourdomain.com` or `notifications@yourdomain.com` |
| `SMTP_TLS` | No | `true` or `false`, defaults to `false` |
| `SMTP_PROVIDER` | No | `smtp2go` or `smtp` (auto-detected by hostname, optional) |
| `INVITE_BASE_URL` | No | `https://jongo.manifest-fts.com` (defaults to `NEXTAUTH_URL` if not set) |
| `INVITE_TOKEN_SECRET` | No | Random string for token signing (defaults to `NEXTAUTH_SECRET`) |
| `INVITE_TTL_DAYS` | No | `7` (default), or customize to different days |

### Email Behavior

**If ALL SMTP vars are set** (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM):
- ✅ Invite emails sent automatically when collaborators are invited
- ✅ Invite-accepted notification sent to inviter
- ✅ Admin can test email via `/api/admin/email/test` endpoint
- ✅ UI shows "Email delivery: Configured ✓"

**If ANY SMTP var is missing**:
- ⚠️ No email sent (silently; error logged on server)
- ✅ Invite link still generated and returnable via API
- ✅ UI shows: "Email delivery not configured yet — copy this invite link manually"
- ✅ Admins can still copy and share invite links manually

### Testing SMTP (After Variables Set)

```bash
# Use admin session to test email delivery
curl -X POST https://jongo.manifest-fts.com/api/admin/email/test \
  -H "Authorization: Bearer <your-session-token>" \
  -H "Content-Type: application/json" \
  -d '{ "to": "test-recipient@example.com" }'

# Expected response (if SMTP configured):
# { "sent": true, "provider": "smtp" or "smtp2go", "messageId": "..." }

# If SMTP not configured:
# { "sent": false, "provider": "none", "error": "SMTP not configured" }
```

---

## Validation Checklist (After Migration)

Run these checks once migration is applied to confirm full invite lifecycle:

### 1. Create Invite for Non-Existing Email

```bash
curl -X POST https://jongo.manifest-fts.com/api/organizations/{orgId}/collaborators \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "role": "collaborator"
  }'

# Expected: 201 response with:
# {
#   "inviteUrl": "https://jongo.manifest-fts.com/auth/invite/abc123def...",
#   "emailDeliveryConfigured": true/false,
#   "pending": true
# }
```

**✅ Pass**: `inviteUrl` returned and `pending: true`

### 2. Validate Invite Token

```bash
curl https://jongo.manifest-fts.com/api/invites/abc123def... \
  -H "Content-Type: application/json"

# Expected:
# {
#   "valid": true,
#   "state": "pending",
#   "email": "newuser@example.com",
#   "expiresAt": "2026-05-24T...",
#   "role": "collaborator"
# }
```

**✅ Pass**: `valid: true, state: pending`

### 3. Accept Invite (Register Path)

```bash
curl -X POST https://jongo.manifest-fts.com/api/invites/abc123def.../accept \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "register",
    "email": "newuser@example.com",
    "fullName": "New User",
    "password": "SecurePassword123!"
  }'

# Expected: 200 response; user created and linked to organization
```

**✅ Pass**: 200 response, new user account created

### 4. Verify Collaborator Appears

```bash
curl https://jongo.manifest-fts.com/api/organizations/{orgId}/collaborators \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json"

# Check response includes new user in collaborators array
```

**✅ Pass**: New user appears in collaborators list

### 5. Reuse Attempt (Should Fail)

```bash
curl -X POST https://jongo.manifest-fts.com/api/invites/abc123def.../accept \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "register",
    "email": "newuser@example.com",
    "fullName": "Attacker",
    "password": "Malicious123!"
  }'

# Expected: 410 or 400 error (token already used/invalid)
```

**✅ Pass**: 410/400 returned; no duplicate account created

### 6. Check Email Delivery (If SMTP Configured)

```bash
# Check mail logs or your SMTP provider's logs for:
# - Invite email sent to newuser@example.com
# - From address matches SMTP_FROM
# - Subject: "You're invited to join [org] on Jongo"
```

**✅ Pass**: Email delivered to inbox (if SMTP configured)

---

## Environment Details

| Item | Value |
|------|-------|
| App Container | `dt0v391xre5rgtp50062tunm-002216038801` |
| App UUID | `dt0v391xre5rgtp50062tunm` |
| Git Repository | `Manifest-FTS/jongo-os` (`main` branch) |
| Database | `o4g2cpls648gnz0f1he7be7c:5432` (pdb-jongo-os-prod) |
| Public URL | `https://jongo.manifest-fts.com` |
| Coolify Server | `coolify.manifest-fts.com` |

---

## Documentation References

- [docs/invite-onboarding-smtp.md](./invite-onboarding-smtp.md) — Full feature documentation
- [docs/INVITE-RUNTIME-VALIDATION-REPORT.md](./INVITE-RUNTIME-VALIDATION-REPORT.md) — Detailed runtime validation report
- [.env.example](../.env.example) — Updated environment variable documentation

---

## Common Issues & Troubleshooting

### Issue: "Invitation table not found" error

**Cause**: Migration 0005 not applied  
**Fix**: Run `npm run db:migrate:deploy` inside app container (see top of checklist)

### Issue: Email not being sent (but no error)

**Cause**: One or more SMTP vars missing or empty  
**Expected behavior**: This is correct; fall back to manual copy mode  
**Check**: Verify all SMTP vars are set (use admin test endpoint)

### Issue: Invite token expired immediately

**Cause**: `INVITE_TTL_DAYS` too short or server time skew  
**Fix**: Check INVITE_TTL_DAYS value; verify server time is correct; check DB timestamp format

### Issue: Cannot accept invite (403 error)

**Cause**: User already exists with that email; invite mode mismatch  
**Fix**: Use `mode: "login"` for existing users; `mode: "register"` for new users  
**Better**: Accept endpoint auto-detects; if you get 403, invite may have bad data

---

## Go-Live Checklist

- [ ] Migration 0005 applied to production DB
- [ ] Invite endpoints return 200 (not 307 redirects on public routes)
- [ ] Create invite: returns `inviteUrl` in response
- [ ] Validate invite token: returns valid metadata
- [ ] Accept invite: creates user or links existing user
- [ ] Accepted user appears as collaborator
- [ ] Reuse attempt rejected with 410/400
- [ ] (Optional) SMTP configured and test email works
- [ ] (Optional) Invite email received in test inbox
- [ ] UI displays invite links and copy button
- [ ] Manual copy fallback works if SMTP disabled
- [ ] Settings panel shows email delivery status
- [ ] Documentation updated with production details
- [ ] Release notes mention invite feature activation

