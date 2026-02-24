# GitHub access for the sandbox user

The sandbox user needs GitHub access to push branches and manage PRs. Use a **fine-grained personal access token** scoped to only the repos your fleet works on.

## Create the token

1. Go to **GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens**
2. Click **Generate new token**
3. Configure:
   - **Token name**: `hivebot` (or similar)
   - **Expiration**: 90 days (set a calendar reminder to rotate)
   - **Resource owner**: your org
   - **Repository access**: Only select repositories — pick the repos your fleet works on
   - **Permissions**:
     - **Contents**: Read and write (push/pull)
     - **Pull requests**: Read and write (open, close, edit, comment)
     - **Issues**: Read and write (reference, close, comment)
     - **Commit statuses**: Read-only (check CI status)
     - **Metadata**: Read-only (auto-selected)
4. Click **Generate token** and copy it

## Install the token

```bash
sudo -u hivebot -H gh auth login --with-token <<< "ghp_your_token_here"
```

Verify:

```bash
sudo -u hivebot -H gh auth status
```

## What this token CAN do

- Push commits and branches
- Create, update, and close PRs
- Comment on PRs and issues
- Read CI status checks

## What this token CAN'T do

- Access other repos outside the selected set
- Change repo settings, branch protection, or webhooks
- Manage org members or teams
- Read or write secrets/variables
- Trigger or cancel CI workflows
- Delete repos

## Rotation

Fine-grained tokens expire. When yours does:

```bash
# Generate a new token in GitHub, then:
sudo -u hivebot -H gh auth login --with-token <<< "ghp_new_token_here"
```
