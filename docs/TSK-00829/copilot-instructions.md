# Jongo OS — GitHub Copilot Instructions

## Core Philosophy
Jongo OS is a client-friendly, high-grade PaaS control panel built on top of Coolify/Docker. 
- **Flywheel Simplicity for Clients:** Hide raw infrastructure noise, UUIDs, low-level Docker trace logs, and unhandled system errors from non-admin/collaborator views.
- **Admin Depth:** Reserve deep infrastructure diagnostics, inventory mapping, and system overrides for Admins and Platform Admins.

## App Architecture & Capability Scaling
Apps are NOT strictly WordPress. Always check app capability flags before rendering platform-specific components:
- `app.type === 'wordpress'`: Render WP Version, PHP Version, Plugins tab, Database prefix, WP_DEBUG toggles.
- `app.type === 'node' | 'nextjs' | 'react' | 'custom'`: Hide WP-specific cards. Render Node/Runtime version, Build Commands, Environment Variables, and API Endpoints.

## Role & UI Gating Rules
Canonical Roles: `admin` | `collaborator` (plus `isPlatformAdmin` via bootstrap email / global scope).

### UI Visibility Matrix:
1. **Platform Admin (Global/Bootstrap):** Full access to raw system telemetry, Coolify UUID mapping, repair triggers, global settings.
2. **Organization / App Admin:** Can invite/manage collaborators, trigger backups, change domain mappings, toggle staging, and edit environment settings.
3. **Collaborator:** Read-focused access + basic daily operations (e.g., access WP-Admin link, view site health, view staging status, view backups).
   - **HIDDEN from Collaborator:** Raw error diagnostics, UUID mismatch banners, "Needs Attention" system-level infrastructure warnings, and team invitation controls.