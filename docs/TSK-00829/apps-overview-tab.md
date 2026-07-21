# UI Spec: Apps > Overview Tab (`apps-overview-tab.md`)

## Fundamental Constraints & Role-Based Rules

### 1. Role Visibility Matrix (`callerRole`)

| UI Element | Collaborator | Admin / Super Admin |
| :--- | :--- | :--- |
| **Technical Health Pills & Telemetry** | ❌ **Hidden** | ✅ **Visible** (Clean header badges or bottom Admin drawer) |
| **Coolify UUIDs & Proxy Alerts** | ❌ **Hidden** | ✅ **Visible** (Collapsible Admin drawer only) |
| **Primary Domain & URL** | ✅ Visible (Read-only) | ✅ Visible (+ Edit / Add capabilities) |
| **Collaborator List** | ✅ Visible (Read-only) | ✅ Visible (+ Invite Modal & Remove Context Menu) |
| **Privacy Mode Toggle** | ✅ Visible (Can toggle) | ✅ Visible (Can toggle) |
| **Server IP & Location** | ✅ Visible (If enabled) | ✅ Visible |

### 2. Strict Brand Isolation
- **No Internal Engine Names:** The string "Coolify" (or raw internal infrastructure jargon) MUST NEVER appear in any user-facing label, tooltip, modal, or error message for either role. Render as "Jongo OS" or "System".

### 3. Engine Noise Filtering
- **Collaborator Rule:** Never show unhandled API errors, inventory mismatch warnings (e.g., *"App not found in inventory"*), or raw trace logs. If an API fails, show a clean fallback: *"Unable to load site settings. Please contact your administrator."*
- **Admin Rule:** Keep system health metrics accessible, but isolate low-level troubleshooting alerts into an Admin-only collapsible container so it doesn't ruin the clean Flywheel aesthetic of the primary dashboard.

---

## 1. Top Navigation & Header Section

### Tab Bar Specification
Update the primary app tab bar as follows:
1. `Overview` (Active)
2. `Deployments`
3. `Plugins` (*CRITICAL:* Only render this tab if `app.type === 'wordpress'`. Hide completely for all other app types.)
4. `Staging`
5. `Backups`
6. `Stats` (*Renamed* from Analytics / Routing / API)
7. `Settings`
8. ~`Integrations`~ (*Comment out / stub in code — hide from UI*)
9. ~`Team`~ (*Comment out / stub in code — team management lives inside Overview*)

### App Title & Sub-Header Meta
Replace traditional breadcrumbs with the following header block:
- **`<h1>` App Name:** Render App / Resource Display Name (e.g., `teach.lgbt`).
- **Meta Line 1:** `[Cloud Icon]` + Clickable Primary URL (opens in new tab). *(Note: Confirm project icon set, e.g. Lucide `Cloud`, before rendering).*
- **Meta Line 2:** `[Building / User Icon]` + Client / Project Name (e.g., `Garden State Equality`).

---

## 2. Page Content Layout & Components

### Card A: Domains
- **WordPress Apps (`app.type === 'wordpress'`):**
  - Render a clean, single primary domain row showing the attached domain + slug.
- **Other App / Resource Types:**
  - Render a multi-domain table (Flywheel-style list) allowing multiple attached domains/aliases.
- **Data Displayed:**
  - Domain Name (clickable)
  - Type Badge (`Primary` | `Secondary` | `Temporary`)
- **Admin Actions:** `+ Add Domain` button (gated to `canEditDomains`). Hidden for basic `collaborator` role.

---

### Card B: Collaborators
*(Replaces the standalone Team tab directly on the Overview page)*
- **Header:** Title "Collaborators" + `+` Icon / `Add Collaborators` Button.
  - Clicking opens the `Add Collaborators` Modal Invite.
  - Button hidden if caller is a `collaborator`.
- **List View:**
  - User Name & Email Address.
  - Role Badge (`Owner`, `Admin`, `Collaborator`).
  - **Admin Action Menu (`...` Context Menu):** Positioned on the right side of each user row to allow `Remove Collaborator`. (Hidden if caller is `collaborator` or if target is the Organization Owner).

---

### Card C: Server Location & Network Info
- **Display:** Resource IP Address + Country Flag icon corresponding to the server's geographic location.
- **Architectural Note for AI:** Wrap this component in an environment flag / config check (`showServerIP`) so it can be cleanly masked or toggled off if traffic is proxied through Cloudflare and server IP hiding is required.

---

### Card D: Privacy Mode (New Feature Specification)

#### UI States:
1. **Toggled OFF (Default):**
   - Render a disabled (gray) toggle switch.
   - Helper Text:
     > *"This site is not in privacy mode, which means visitors (and search engines) can discover your content. Need to make some changes that you don’t want everyone to see? Feel free to turn on privacy mode at any time."*

2. **Toggled ON:**
   - Render an active (colored) toggle switch.
   - Display auto-generated Basic Authentication credentials:
     - **Username:** `flywheel` (or default Jongo OS username)
     - **Password:** Display auto-generated random password with a 1-click "Copy" button and a "Regenerate" option.
   - Helper Text: *"Privacy mode is active. Visitors must enter these credentials to view the site."*

#### Backend / Infrastructure Requirement for AI:
- Toggling Privacy Mode MUST send an API request to enable/disable HTTP Basic Authentication on the reverse proxy layer (e.g., Traefik BasicAuth middleware via backend API / SSH script).

---

## 3. Developer / Copilot Checklists
- [ ] Is "Coolify" completely absent from all strings?
- [ ] Are telemetry/health status cards completely removed from the Overview tab?
- [ ] Is the `Plugins` tab hidden for non-WordPress applications?
- [ ] Is `Analytics` renamed to `Stats`?
- [ ] Are `Integrations` and `Team` tabs commented/stubbed out?
- [ ] Does Privacy Mode toggle trigger the BasicAuth middleware API route?