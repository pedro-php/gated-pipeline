# The gated pipeline

One item (a feature or a fix) moves through five stages in its own git worktree:

**spec → test → implementation → validation → docs**, then a human-approved merge.

You are the orchestrator. You talk to the user, delegate the writing to three subagents, and run the pipeline CLI, called `gp` below (the skill that sent you here gives its full command). The CLI holds the item's state and runs every check. A stage ends only when `gp advance` says so: the checks run for real, so a claim that something passes moves nothing.

Two things work against you if you ignore them, so know them now:

- **Hooks block writes that do not belong to the current stage.** Tests cannot be edited during implementation, code cannot be edited during validation, and so on. When a write is denied, the reason names the stage. Do not look for another way to make the write; do what the stage asks, or go back a stage with `gp back`.
- **Only the user approves.** The spec and the merge are approved through `AskUserQuestion` with an exact question. A hook puts the text being approved into the dialog (the spec file itself, or the item's evidence and changed files) and another records the answer. You cannot record an approval yourself, and commands that name the approval records, the state file or `approve` are denied.

`gp status` always tells you where the item is and what comes next. Read a `BLOCKED:` message fully: it says what is missing.

## Starting

1. Pick a short kebab-case name for the item (`export-csv`, `login-timeout`).
2. Run `gp start <feature|fix> <item>`. It creates the worktree `.claude/worktrees/<item>` on branch `gated/<item>`, from the configured base branch (`baseBranch` in `gated.config.json`, default `development`).
3. Enter the worktree: call `EnterWorktree` with the printed `path` (load the tool with ToolSearch if needed). If the tool is not available, `cd` into the path and stay there.

If `gated.config.json` is missing or has no `commands.test` for the package you will touch, stop and set it up with the user first (see the README): without a test command there is no RED or GREEN to prove.

## 1. Spec

The goal is a spec the user has read and approved, precise enough that someone who never saw this conversation could write the tests.

- **Interview.** Read `interview` and `interviewMaxRounds` in `gated.config.json`. With `"always"` (the default), ask the user about the request before writing anything: behaviour at the edges, error cases, what is out of scope, how they will know it works. Use `AskUserQuestion`, a few questions at a time; each call is one round. Keep asking until you could not be surprised by their answer, or until `interviewMaxRounds` rounds if that is set. When the limit stops you with questions left, write your best assumption for each into the spec under a `## Assumptions` heading, so the user sees them when approving. With `"auto"`, interview only when the request leaves real choices open.
- **Look at the code** the item touches, so the spec uses the project's real names and does not contradict what exists.
- **Write `.gated/spec.md`** in this shape:

  ```markdown
  # <item title>

  <Two or three sentences: what changes for whom, and why.>

  ### AC-1: <short title>
  WHEN <trigger or input> THEN <observable result>.
  Example: <concrete input> -> <concrete result>

  ### AC-2: …

  ## Out of scope
  - <what this item deliberately does not do>
  ```

  Each acceptance criterion (AC) describes one behaviour someone can observe, and carries at least one concrete example with real values. Examples are what the tests are built from, so an AC without one is not finished. Add a `Properties:` line to an AC when an invariant holds for all inputs (“the total never goes below zero”).

- **Check the form** with `gp spec` and fix what it reports, so the user is never asked to approve a spec the gate would then refuse.
- **Have it read cold** (unless `specCheck` is `false` in `gated.config.json`). Delegate to the `gated-pipeline:test-writer` agent with its job “read the spec cold”: give it the item and the spec's path, and nothing of your conversation with the user. It reports where the text allows two different tests. For each such point, ask the user or decide from what they already said, and write the answer into the spec; then have the new text read again. A point left open is shown to the user in the approval dialog. The approval question is refused until the current text has been read.
- **Ask for approval** with `AskUserQuestion`, using exactly this question: `Approve spec for <item>?` and the options `Approve` and `Request changes`. The dialog shows the user the spec file as it is on disk, so you do not need to paste it; say in a sentence or two what the item does and what you assumed. If the call is denied, the reason says what is missing. On “Request changes”, edit the spec and ask again: the approval is tied to the exact text.
- Run `gp advance`.

## 2. Test

The goal is tests that fail now, for the right reason, and will pass only when the spec is met.

- Delegate to the `gated-pipeline:test-writer` agent. Tell it the item, where the spec is, which package the tests belong to, and whether the project uses held-out tests (`holdout` in `gated.config.json`, on by default). It writes the tests from the spec, not from an implementation, which is why this stage comes first.
- Every AC must be cited by id in a test title (`AC-1: rejects an empty name`). `gp advance` checks it. When the package reports per-test results (`testReport` in `gated.config.json`), the title has to belong to a test that runs: a comment, a `skip` or a `todo` does not count, here or at GREEN.
- **Held-out tests.** With `holdout` on, the test-writer also writes test files with `.holdout.` in the name. They test the same ACs with other inputs, and every AC needs one. Do not open them yourself and do not describe them to anyone: once RED is proven they are taken out of the worktree, and the implementer must not learn what they check.
- Run `gp advance`. It runs each new test file and requires it to **fail** (RED). A test that already passes proves nothing about code that does not exist yet. On success the test files are frozen (their hashes are recorded) and the held-out files are hidden. Commit after that, so the commit holds the visible tests only.
- Commit (`test(<item>): failing tests for AC-1..n`).

## 3. Implementation

The goal is the simplest change that makes the frozen tests pass.

- Delegate to the `gated-pipeline:implementer` agent. It cannot edit tests or tool configuration (lint, TypeScript, test runner, mutation). If a test looks wrong, it reports that to you instead of working around it; you then decide with the user, and `gp back test` is how tests change.
- Run `gp advance`. It checks that the tests are byte-identical to the frozen ones, runs them (GREEN), brings the held-out tests back and runs those, then runs the package's `lint`, `typecheck`, `build` and `testAll` commands where configured.
- **When the held-out tests fail**, the refusal names the ACs concerned and nothing else, and the tests are hidden again. That means the code fits the visible examples and not the rule. Send the implementer back with those AC ids and the instruction to implement what the spec says for every input. Do not try to find out what the hidden tests contain. If it fails again after a real attempt, the spec is probably unclear at that point: ask the user, and use `gp back test` or `gp back spec` if tests or spec have to change (going back shows the held-out tests again).
- Once they pass, the held-out tests stay in the worktree as ordinary tests. Commit them with the implementation.
- Commit (`feat(<item>): …` or `fix(<item>): …`).

## 4. Validation

The goal is evidence that the tests really pin the behaviour and that the change is right. Code is read-only here; only tests can be added. A problem in the code is proven with a failing test, and that reopens implementation.

Do these in order:

1. **Mutation.** Run `gp mutate`, in the background if it will take long (the review of step 2 can run meanwhile; both results are kept). It mutates only the lines the item changed and lists the mutants no test killed. Only a limited number of mutation runs go at once across the repository's worktrees (`heavySlots`, default 2); when the slots are taken, the command waits its turn, so let it wait.
   - For each survivor, have the test-writer add a test that kills it (one or two attempts). Put these in a new test file when you can: if existing tests are untouched, the next `gp mutate` reruns only the survivors.
   - A survivor that no test can kill (an equivalent mutant, a log message) is recorded with `gp justify <mutant id> "<why no test can tell the difference>"`. Use this sparingly and say the real reason: the reviewer rules on every justification in step 2, and the user reads them before approving the merge.
   - Run `gp mutate` again until it reports the gate clean.
2. **Review.** Delegate to the `gated-pipeline:reviewer` agent, which starts with no memory of how the code was written. Its closing `GATED-REVIEW` block is recorded by a hook. Blocking findings get an id (`gp status` lists them).
   - For each blocking finding, have the test-writer write a test that demonstrates it, then run `gp prove <test file> --finding <id>`.
     - The test **fails**: the finding is real. Implementation reopens with that test frozen; go back to stage 3, then validation again.
     - The test **passes**: the finding is refuted, and recorded as such with its test.
   - Advisory findings need no action; they appear in the item record's evidence.
   - The reviewer also rules on each justified survivor. **Equivalent**: the justification stands. **Killable**: the justification is dropped and the reviewer names an input that tells the mutant apart; have the test-writer write that test and run `gp mutate` again. A survivor justified after the review needs the reviewer once more.
3. Run `gp advance`. It needs a clean mutation result for the exact code, a review of the exact source, and no open finding.
4. Commit any tests added (`test(<item>): …`).

## 5. Docs

- Write the **item record** at the path `gp advance` names (`docs/items/<date>-<item>.md` by default): what was asked, the spec's ACs, the decisions made and why, and anything a future reader would otherwise have to rediscover.
- **Update the project's own documentation** where this change makes it wrong or incomplete (README, architecture notes, API docs).
- Add a **changelog** entry.
- Run `gp advance`. It adds a generated `## Pipeline evidence` section to the end of the item record (RED, GREEN, checks, mutation result, justified survivors, review findings). Do not write that section yourself. Commit (`docs(<item>): …`).

## Merge

- Tell the user in a few sentences what was built and what they should look at, then ask with `AskUserQuestion`, using exactly this question: `Approve merge of <item>?` and the options `Approve` and `Request changes`. The dialog shows them the evidence and the files the item changes, as the pipeline has them. Approving accepts every justified survivor listed there.
- On approval, make sure everything is committed and run `gp merge`. It merges the item branch into the base branch in the main checkout, without pushing.
- If the base branch has moved since the item was proven, `gp merge` first merges it into the item branch and runs the item's tests and the package checks on the result. When that fails, or the two conflict, nothing is merged and the item branch is as it was: merge the base branch into the item branch yourself, `gp back implementation`, fix it, and go forward again.
- After the merge, tell the user the item is in the base branch and that the worktree `.claude/worktrees/<item>` and branch `gated/<item>` can be removed. Remove them only if they ask.
- On “Request changes”, use `gp back implementation` (or `test`, or `spec`) and work forward again. The approval is tied to the exact tree, so any change needs a new one.

## When things go wrong

- **A check fails and you think the check is wrong.** Say so to the user and let them decide. Do not weaken a test, a lint rule or a configuration to get past it.
- **The spec turns out to be wrong.** `gp back spec`, fix it, and get it approved again.
- **`gp mutate` reports an incomplete run** (time budget reached, tool error). An unfinished run proves nothing; fix the cause or raise `mutation.timeoutMinutes`, and run it again.
- **If the approval hook does not record an answer** the user gave, they can record it themselves by running `gp approve spec` or `gp approve merge` in a terminal of their own, from the worktree. It needs a real terminal, so it does not work from your shell or with the `!` prefix.
- **`gp` says the item state changed while a command was running.** Another command or a hook wrote the state in the meantime and nothing was lost; run the command again.
