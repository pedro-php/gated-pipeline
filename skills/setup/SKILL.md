---
name: setup
description: Set up the gated pipeline in this repository. Inspects the project, writes gated.config.json (packages, test, lint, typecheck and build commands, per-test results, mutation testing) and checks that the pipeline understands it.
argument-hint: "[anything to know about the project]"
disable-model-invocation: true
---

# /setup

The user wants this repository ready for the gated pipeline. That means a `gated.config.json` at the repository root that is right for this project, checked, and committed by them.

$ARGUMENTS

The pipeline CLI is `gated`, on your PATH while the plugin is enabled. If the shell does not find it, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/gp.mjs"` instead. Every setting is described in `${CLAUDE_PLUGIN_ROOT}/README.md` under "Configure your project": read that section first, and `${CLAUDE_PLUGIN_ROOT}/gated.config.example.json`.

If a `gated.config.json` already exists, run `gated config`, tell the user what it says, and change only what they ask for or what is wrong.

## 1. Look at the project

Find out, from the files and not from guesses:

- **Packages.** One package per part of the repository that has its own test command (a monorepo's workspaces, a `server/` and a `frontend/`). A single-package project is one package with root `.`.
- **Where source and tests live**, as globs relative to each package root. Test helpers and fixtures belong under `tests`.
- **The test runner** of each package and how to run a chosen list of test files with it. The pipeline replaces `{files}` with the paths.
- **Per-test results.** If the runner is Jest, Vitest, node:test or anything that writes JUnit XML, add the reporter flags and `testReport` as the README's table shows. This is what lets the gates tell a test that ran from one that was skipped.
- **Whole-package checks** that exist as scripts: lint, typecheck, build, the full test suite.
- **Mutation testing.** Is StrykerJS installed in the package, or another mutation tool that can write the mutation-testing report schema? If none is, the package gets `"mutation": false`, which the user must agree to: it states that the package has no mutation gate.
- **The base branch** items start from and merge into, and how a fresh git worktree gets its dependencies (`setup`: an install command, or a link to the main checkout's installed dependencies).

## 2. Ask what the files cannot tell you

Use `AskUserQuestion` for the decisions that are the user's: the base branch if it is not obvious, whether a package without a mutation tool should get one installed or go without, and whether to keep the two defaults that cost extra work on every item (`specCheck`, `holdout`). Say what each costs and gives. Do not ask about what you can read from the repository.

## 3. Write and check

1. Write `gated.config.json`. Leave out settings whose default is right.
2. Run `gated config`. It refuses a file with an unknown or misplaced setting and says which; otherwise it prints what the pipeline understood for each package. Fix what it reports.
3. Prove the test command on one existing test file of each package: run it exactly as the pipeline would, with `{files}` replaced by that file and `{report}` by a path under `.gated/`, and confirm that the exit code is 0 and, with `testReport`, that the report file was written. Delete the report afterwards. A test command that does not work here would block the first item at its first gate.
4. If the package uses Stryker, check that `npx stryker --version` runs in it.

## 4. Hand over

Tell the user what you wrote and why, and what you could not verify. Do not commit: the configuration decides what the gates check, so they read it first. Mention the two optional hardening settings the README describes for their own Claude Code settings (the sandbox rule for `.git/gated-approvals`, the read rule for `.git/gated-holdout`), and that the first item starts with `/gated-pipeline:feature` or `/gated-pipeline:fix`.
