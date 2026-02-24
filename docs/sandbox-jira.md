# JIRA access for the sandbox user

The sandbox user needs JIRA access to create tickets, add comments, and transition issues. Use an **API token** scoped to a service account or your own account with limited project access.

## Option A: Use your own API token (quick setup)

This gives the sandbox user the same JIRA access as you. Fine if you trust the sandbox isolation and want to get started fast.

1. Go to **https://id.atlassian.com/manage-profile/security/api-tokens**
2. Click **Create API token**
3. Label it `hivebot` so you can revoke it independently
4. Copy the token

## Option B: Create a service account (recommended)

Create a dedicated Atlassian account for hivebot with access to only the projects your fleet works on.

1. Create a new Atlassian account (e.g. `hivebot@yourcompany.com`)
2. In JIRA admin, add the account to only the projects your fleet needs (e.g. DEV project)
3. Give it the **Developer** or **Member** role — not Admin
4. Generate an API token from that account

This limits blast radius: even if the token leaks, it can only access the projects you assigned.

## Install the credentials

Create a `.env` file in the sandbox user's home directory:

```bash
sudo -u hivebot -H bash -c 'cat > ~/.env << EOF
JIRA_USERNAME=your-email@company.com
JIRA_API_TOKEN=your-api-token
JIRA_URL=https://yourcompany.atlassian.net
EOF'

# Lock it down
sudo -u hivebot chmod 600 /Users/hivebot/.env
```

If your Claude sessions source `~/.env` for JIRA access (as described in your CLAUDE.md), this will work automatically since hivebot's `~/.env` is separate from your main user's.

## Verify

```bash
sudo -u hivebot -H bash -c '
  source ~/.env
  curl -s -u "${JIRA_USERNAME}:${JIRA_API_TOKEN}" \
    "${JIRA_URL}/rest/api/2/myself" | python3 -m json.tool
'
```

You should see the account details. If you get 401, double-check the username (must be the email, not the display name).

## What this gives the sandbox user

- Create and update tickets in assigned projects
- Add and edit comments
- Transition issues (e.g. "In Progress" -> "In Review")
- Read ticket details, sprint boards, and backlogs
- Link tickets to each other

## What this CAN'T do (with service account)

- Access projects the account isn't a member of
- Admin actions (delete projects, manage users, change workflows)
- Access Confluence (unless separately granted)

## Revocation

If you need to revoke access:

1. Go to **https://id.atlassian.com/manage-profile/security/api-tokens**
2. Find the `hivebot` token and click **Revoke**

The sandbox user's `~/.env` will still have the old token but it won't work.
