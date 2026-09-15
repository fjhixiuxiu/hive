# Formatting, and keeping history readable through it

`npm run format` (prettier) owns the shape of this codebase. `format:check` runs from
`pretest`, so `npm test` — and therefore CI and the pre-commit hook — fail on an
unformatted tree.

The settings in `.prettierrc.js` are a _description_ of the 34,000 lines hive was already
written in, measured rather than chosen. They are not a preference and there is no reason
to argue about them.

## The one-time reformat, and what it did to blame

`3dd5634` ("chore(format): adopt prettier…", #352) touched 99 files. Left alone, it would
sit on top of every one of those files in `git blame`, so every line would read as having
last been changed by a formatting commit rather than by whoever actually wrote it.

`.git-blame-ignore-revs` fixes that. `npm run prepare` wires it up:

```
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

That runs on `npm install`, so a fresh clone gets it without anyone remembering. **GitHub
reads the file on its own** — the web blame view needs no setting.

To confirm it is active in your clone:

```
git config --get blame.ignoreRevsFile        # → .git-blame-ignore-revs
git blame src/core/taskqueue.js | head       # → no 3dd5634 lines
```

### What belongs in that file

Only bulk rewrites whose semantic diff is empty. A commit listed there is one blame looks
straight _through_ — so listing a commit that changed behaviour hides that behaviour from
the next person trying to find out who changed it and why. That is worse than a noisy
blame, because it is silent.

The bar #352 met, and the bar to meet again: every changed file re-printed from both its
old and its new source at `--print-width 1`, all pairs byte-identical.

## What the ignore file does NOT cover

`blame.ignoreRevsFile` is understood by `git blame` and by GitHub's blame view. Nothing
else reads it, so the reformat is still in the way of:

- **`git log -S` / `-G` (pickaxe).** Searching for when a string appeared will match the
  reformat. Add `-w` to ignore whitespace-only moves:
  ```
  git log -w -S'someFunction' -- src/
  ```
- **`git log -p` on a file that crosses the boundary.** Same fix:
  ```
  git log -p -w --follow src/core/watcher.js
  ```
- **Line-count and churn stats.** `git log --shortstat`, `--stat`, and anything built on
  them count `3dd5634` as ~6,750 added and ~3,328 removed lines. Any velocity or
  contribution number spanning 2026-09-14 is wrong unless that commit is excluded:
  ```
  git log --shortstat --invert-grep --grep='chore(format): adopt prettier'
  ```
  or exclude by SHA directly:
  ```
  git log --shortstat 3dd5634^..HEAD --not 3dd5634
  ```
- **`git bisect`.** The reformat is not a behaviour change, so a bisect that lands on it
  should `git bisect skip` rather than treat it as the culprit.

## Open branches that predate the reformat

A branch cut before `3dd5634` will conflict with `main` on every file it touches that was
reformatted — the conflict is formatting on one side and content on the other, not two
competing edits.

Resolve it by keeping **your branch's content** and re-running the formatter, rather than
hand-merging hunks:

```
git merge main                       # conflicts
git checkout --ours -- <file>        # your content, unformatted
npx prettier --write <file>          # now in main's format
```

⚠️ `--ours` is only safe for a file whose _only_ change on `main` is formatting. If `main`
also changed that file's behaviour since you branched, you will drop that change — resolve
those by hand.

The check that proves you did not lose anything: your branch's file should differ from
`prettier(main's version)` by exactly your intended change, and nothing else.
