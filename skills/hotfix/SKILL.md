---
name: hotfix
description: Emergency fix. Solves a production problem as fast as possible in its own worktree, with only a build and test check and the user's approval before merging. Skips spec, mutation testing and review.
argument-hint: <what is broken>
disable-model-invocation: true
---

# /hotfix

Something is broken and the user needs it fixed now:

$ARGUMENTS

This is the emergency path. Speed matters more than proof here: there is no spec, no interview, no RED test requirement, no mutation testing and no review. What remains is a quick check that the fix builds, and the user's approval before it merges.

The pipeline CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/gp.mjs"`, called `gp` below; always run the full command.

1. **Start.** Pick a short kebab-case name and run `gp start hotfix <item>`. It creates the worktree `.claude/worktrees/<item>` from the hotfix base branch (`hotfix.baseBranch` in `gated.config.json`, otherwise `baseBranch`). Enter it with `EnterWorktree` and the printed `path`, or `cd` into it.
2. **Fix.** Find the cause and make the smallest change that removes it. Do it yourself; do not delegate. Ask the user only what you cannot find out and cannot safely guess. Leave refactoring and nearby problems alone; mention them at the end instead. If a regression test is quick to write, add it, but do not let it slow the fix down.
3. **Check.** Run `gp advance`. It runs the checks listed in `hotfix.checks` (by default typecheck, build, and the item's test files) and writes a short record in the docs folder that names what was skipped.
4. **Approve and merge.** Tell the user in two or three sentences what was wrong and what you changed, then ask with `AskUserQuestion`, using exactly this question: `Approve merge of <item>?` and the options `Approve` and `Request changes`. On approval, commit everything and run `gp merge`. It merges into the base branch in the main checkout and does not push or deploy; tell the user that is theirs to do.
5. **Say what is owed.** A hotfix leaves a debt: no regression test was required and nothing was mutation-tested or reviewed. Tell the user so, and suggest a `/fix` for the same problem once the emergency is over.

If a check fails, fix that and run `gp advance` again. If the description above is empty, ask what is broken.
