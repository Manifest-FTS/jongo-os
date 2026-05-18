# Jongo OS - Team & Access Control Architecture Direction

**Date:** 2026-05-18  
**Status:** ARCHITECTURE DIRECTION (to guide future implementation)  
**Scope:** Platform-level Team & Access management UX

---

## Core Principle

**No new permission layers.** Reuse existing scope model and collaborator infrastructure.

---

## Scope Model (FIXED)

Three-tier hierarchy:
```
Platform (global)
  ├── Client (organizational unit)
  │   └── App (resource/workspace)
```

- **Platform:** Bootstrap admin, global settings, multi-client/multi-app access management
- **Client:** Organization/customer workspace, team members
- **App:** Individual resource/project, collaborators
- **NOT:** A fourth role layer or separate permissions system

---

## Future Team & Access Entry Point

### User Journey
Platform Admin → Settings → Team & Access  
↓  
Unified access management for:
- Platform-wide access (global operators)
- Client-level access (client managers)
- App-level access (app collaborators)

### Implementation Constraints
1. **Reuse existing systems:**
   - Invite/accept flow (already working via NextAuth)
   - Collaborator records (existing relationship)
   - Role enumeration (admin, collaborator)

2. **Don't duplicate:**
   - ❌ Don't create a separate "access control service"
   - ❌ Don't build role matrix UI (stays simple: admin or collaborator)
   - ❌ Don't add intermediate permission checks (scope-based checks sufficient)

3. **Keep existing team pages as-is:**
   - Client Team page = manage that client's collaborators
   - App Team page = manage that app's collaborators
   - No consolidation needed; just add platform-level management

---

## Access Assignment Options for Platform Admin

```
Can assign:
├── Platform access
│   ├── Bootstrap admin (rare, security-gated)
│   └── Platform operator (view all, no write)
├── Client access (pick one or more clients)
│   ├── Client admin (that client only)
│   └── Client operator (view only)
└── App access (pick one or more apps)
    ├── App admin (that app only)
    └── App collaborator (that app only)
```

All invites flow through existing invite system (email token).

---

## Future Implementation Checklist

- [ ] Create `Platform → Settings → Team & Access` page
- [ ] Build invite form that supports multi-level assignment:
  - [ ] Invite email
  - [ ] Select scope: Platform / Client(s) / App(s)
  - [ ] Select role: admin or collaborator (per scope)
- [ ] Extend existing invite acceptance flow to handle multi-scope invites
- [ ] Reuse Prisma relationships:
  - [ ] User.platformRole (optional, for bootstrap admin)
  - [ ] Organization.collaborators (already exists, reuse)
  - [ ] Site.collaborators (already exists, reuse)
- [ ] Add audit trail for access changes (future: log to Organization.audit_log)
- [ ] Validation layer: ensure no privilege escalation

---

## What Does NOT Change

✅ **Keep existing:**
- Client Team page (manage that client)
- App Team page (manage that app)
- Invite acceptance flow (email tokens)
- Role model (admin/collaborator only, no matrix)
- Database relationships (no new tables needed)

---

## Architectural Coherence

This approach maintains:
- **Scope clarity:** Always know which level you're managing
- **Least privilege:** Explicit assignment (no implicit access)
- **Consistency:** Same collaborator model across all scopes
- **Fail-closed:** Default is no access, must be explicitly granted
- **Auditability:** Changes trackable through existing audit hooks

