---
name: commit-pull-merge
description: Branch, commit, PR, merge, and return to main in one shot.
argument-hint: "[commit message summary]"
---

Ship the current changes through a PR workflow. Steps:

1. Run `git status --short` and `git diff --stat` to see what's changed
2. If no changes, report "Nothing to commit" and stop
3. Create a branch name from the changes (short, kebab-case, descriptive)
4. Run: `git checkout -b {branch}`
5. Stage the changed files (specific files, not `git add -A`)
6. Commit with a good message. If the user provided an argument, use it as the summary. Otherwise infer from the diff. Always end with `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
7. Push: `git push -u origin {branch}`
8. Create PR: `gh pr create --title "{title}" --body "{body}"` with a Summary section and Test plan
9. Merge: `gh pr merge {number} --merge`
10. Switch back: `git checkout main && git pull`
11. Report the merged commit hash
