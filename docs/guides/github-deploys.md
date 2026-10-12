# GitHub deploys

Clients connect their own GitHub account or organization to Jongo, create apps from
their repos (private ones included), and every push to the linked branch deploys.
Everything happens in jongo.app.

## 1. One-time setup (platform admin)

1. Open **Settings → Platform → Manage the Jongo GitHub App** (`/admin/github`).
2. Enter the app name (unique on GitHub) and the GitHub organization that should own it
   (leave empty for your personal account).
3. Click **Create Jongo GitHub App**, confirm on GitHub. You come back to Jongo.

Jongo stores the app id, client secret, webhook secret and private key encrypted in its
database (key: `NEXTAUTH_SECRET`), and uploads the private key to the hosting server.
If the key upload failed, use **Upload key** on the same page.

The app asks for: **Contents: read**, **Metadata: read**; events **push** and
**repository** (install events are always sent). Webhooks go to
`https://jongo.app/api/github/webhook`.

Requirements: `NEXTAUTH_SECRET` set (signs connect links); `PUBLIC_SITE_URL` or
`NEXTAUTH_URL` set to the public address so GitHub redirects back correctly.

## 2. Connect a client (client admin)

1. Open the client's **Settings**. In the **GitHub** card click **Connect GitHub**.
2. On GitHub pick the account or organization and which repos Jongo may read.
3. Back in Jongo the card shows the account. If it says **Finishing setup**, click
   **Finish setup** (it also retries every hour).

If you aren't an owner of the GitHub organization, GitHub sends an approval request to
its owners; the connection completes once one approves.

## 3. Create an app from a repo

**Apps → Add App → Deploy from GitHub**: pick the repo, branch, build (Auto-detect or
Dockerfile), port, optional base directory and environment variables. Jongo creates the
app, applies its address and starts the first deploy.

## 4. Pushes, staging, manual deploys

- A push to the production branch deploys production.
- In the app's **Settings → Source**, set a **staging branch**: pushes there redeploy the
  staging copy (when staging is on).
- Turn off **Deploy automatically** to review first: Jongo shows "New commit available"
  with a **Deploy** button.

## 5. Revoking access

- Remove repos or uninstall the app on GitHub (**Choose repos on GitHub** in the card).
- Or click **Disconnect** in Jongo, then uninstall on GitHub to remove access completely.

Affected apps keep running. They show a warning ("Jongo can no longer read this repo"…)
with **Reconnect on GitHub**, and pushes stop deploying. The hourly check catches any
change whose webhook was missed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "GitHub deploys aren't set up on this platform yet" | A platform admin creates the app (step 1). |
| Card stays on **Finishing setup** | **Finish setup**; if it persists, **Upload key** on `/admin/github`. |
| A repo is missing from the picker | Add it under **Choose repos on GitHub**. |
| "already connected to another client" | One GitHub install belongs to one client. Disconnect it there first. |
| Push didn't deploy | Check the branch matches **Source**, the app shows no warning, and auto-deploy is on. Webhook deliveries are listed in the GitHub App's settings. |
