# gated-pipeline

A Claude Code plugin that takes one change at a time through **spec → test → implementation → validation → docs**, and does not let a stage end until its checks have actually run.

Claude writes the spec with you, writes failing tests from it, implements until they pass, then has the result attacked by mutation testing and an independent reviewer. Hooks keep each stage honest: tests cannot be edited while implementing, code cannot be edited while validating, and only you can approve the spec and the merge.

```
/gated-pipeline:feature add CSV export to the reports page
/gated-pipeline:fix     login fails when the email has uppercase letters
/gated-pipeline:hotfix  checkout returns 500 since the last deploy
```

## What each stage proves

| Stage | Who works | The gate (`gp advance`) passes when |
|---|---|---|
| **Spec** | Claude interviews you and writes numbered acceptance criteria, each with a concrete example | you approved that exact text |
| **Test** | `test-writer` agent, from the spec alone | every criterion is cited by a test that runs, and every new test file **fails** (RED) |
| **Implementation** | `implementer` agent | the tests are byte-identical to the ones frozen at RED and now **pass** (GREEN), each criterion by a test that ran; the held-out tests, which the implementer never saw, pass too; lint, typecheck and build pass; no tool configuration was changed |
| **Validation** | mutation tool, `reviewer` agent, `test-writer` | no mutant on the changed lines survives without a killing test or a written justification; every blocking review finding was proven or refuted by a test |
| **Docs** | Claude | the item record and the changelog entry exist; the pipeline adds its evidence to the record |
| **Merge** | you | you approved that exact tree |

Each item lives in its own git worktree (`.claude/worktrees/<item>`, branch `gated/<item>`), so several can be in progress at once.

`/hotfix` is the emergency button: no spec, no mutation testing, no review. It fixes the problem, checks that the project still builds, asks for your approval and merges. The record it writes names what was skipped.

## Install

```
/plugin marketplace add pedro-php/gated-pipeline
/plugin install gated-pipeline@gated-pipeline
```

It needs Node 20 or later and git. The plugin itself has no dependencies.

## Configure your project

Add `gated.config.json` at the repository root and commit it. [`gated.config.example.json`](gated.config.example.json) shows a three-package setup; the smallest useful one is:

```json
{
  "baseBranch": "development",
  "setup": ["npm ci"],
  "packages": [
    {
      "name": "app",
      "source": ["src/**"],
      "tests": ["**/*.test.ts"],
      "commands": {
        "test": "npx jest {files} --json --outputFile={report}",
        "lint": "npm run lint",
        "typecheck": "npm run typecheck",
        "build": "npm run build"
      },
      "testReport": "jest",
      "mutation": { "adapter": "stryker", "runner": "jest" }
    }
  ]
}
```

| Setting | Meaning | Default |
|---|---|---|
| `baseBranch` | branch items start from and merge into | `development` |
| `holdout` | `true`: every item needs held-out tests for each criterion (below). `false`: none | `true` |
| `interview` | `always`: interview before every spec. `auto`: only when the request is ambiguous | `always` |
| `interviewMaxRounds` | optional cap on interview rounds (one round = one batch of questions); open points left become written assumptions in the spec | no cap |
| `heavySlots` | mutation runs allowed at once across the repository's worktrees; others wait their turn. `0` = no limit | 2 |
| `heavySlotWaitMinutes` | how long a mutation run waits for a slot before it reports incomplete | 120 |
| `setup` | shell commands run in each new worktree, to install or link dependencies. `$GATED_MAIN_ROOT` is the main checkout | none |
| `docs.records` | folder of item records (one file per item: what Claude wrote plus the generated evidence) | `docs/items` |
| `docs.changelog` | changelog file that must get an entry; `false` for none | `CHANGELOG.md` |
| `docs.paths` | what counts as documentation: editable in the docs stage, and not part of the proven code | `docs/**`, `**/*.md` |
| `hotfix.checks` | checks a hotfix runs | `typecheck`, `build`, `test` |
| `hotfix.baseBranch` | branch hotfixes start from | `baseBranch` |
| `checkTimeoutMinutes` | time limit of one check command | 15 |

Per package:

| Setting | Meaning |
|---|---|
| `root` | package folder (default: the repository root). Globs below are relative to it |
| `source`, `tests` | globs (`**`, `*`, `?`) for source and test files. Test helpers and fixtures belong under `tests` |
| `protected` | tool configuration no item may change (defaults cover Jest, Vitest, Stryker, TypeScript and ESLint config files) |
| `commands.test` | runs the given test files; `{files}` is replaced by their paths. **Required** |
| `holdout` | globs of the test files that are held out (default `**/*.holdout.*`). They must also match `tests` |
| `testReport` | `jest`, `vitest` or `junit`: the per-test report `commands.test` writes to `{report}` (below). Optional, recommended |
| `commands.testAll`, `lint`, `typecheck`, `build` | optional whole-package checks |
| `mutation` | the mutation gate (below), or `false` to state the package has none. A touched package must say one or the other |

### Per-test results

Without `testReport`, a test run speaks only through its exit code, and a criterion counts as cited when its id appears anywhere in a test file. That lets through a criterion named only in a comment, or in a test marked `skip` or `todo`.

With `testReport`, the gates read one result per test from the file the runner writes to `{report}`:

- **RED**: a criterion must be in the title of a test that runs. The item record says how each criterion stood before the implementation: a test naming it failed, or its tests passed already (they pin behaviour that already held).
- **GREEN**: each criterion must be in the title of a test that ran and passed, and a run that executed no test is not a pass.

A test file that cannot load yet, because it imports a module the implementation will add, has no titles to read at RED; it is searched as text there, and held to its titles at GREEN.

| Runner | `commands.test` | `testReport` |
|---|---|---|
| Jest | `npx jest {files} --json --outputFile={report}` | `jest` |
| Vitest | `npx vitest run {files} --reporter=json --outputFile={report}` | `vitest` |
| node:test | `node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination={report} {files}` | `junit` |
| pytest, Go, Rust, others | any command that writes JUnit XML to `{report}`, such as `pytest {files} --junitxml={report}` | `junit` |

Keep a human-readable reporter on standard output as well: the tail of it is what Claude sees when a gate fails.

### Held-out tests

An implementer that can read every test can satisfy the tests instead of the spec, by special-casing the examples. So the test-writer writes two sets from the same spec: the visible tests, and held-out tests in files with `.holdout.` in the name (`export.holdout.test.ts`) that check the same criteria with other inputs.

- Both sets must fail at RED and both are frozen. Then the held-out files are taken out of the worktree and kept, packed, in the repository's git directory. The implementation stage works without them.
- `gp advance` at the end of implementation brings them back and runs them. If they pass, they stay as ordinary tests of the item: mutation testing and the reviewer see them, and they are merged with the rest.
- If they fail, they are hidden again and the refusal names only the criteria concerned, never the test. Every detail given about a hidden test is one the code can then be fitted to.
- `gp back test` shows them again, for whoever has to change the tests.

The guard denies any command or edit that names the store (`.git/gated-holdout/`). To close it to the file-reading tools as well, add a permission rule to your settings: `"permissions": { "deny": ["Read(//absolute/path/to/your/repo/.git/gated-holdout/**)"] }`.

### Mutation testing

The gate mutates only the lines the item changed. A surviving mutant must be killed by a new test, or justified in writing; you see every justification in the item record before approving. There is no score threshold. A run that hits its time budget is incomplete and blocks, it never passes.

**StrykerJS** (`"adapter": "stryker"`): install `@stryker-mutator/core` and a runner in the package. Your own `stryker.config.*` is kept; the pipeline overrides `mutate`, the reporters and, when set here, `concurrency`. Options: `runner` (`"jest"` enables the per-file runner below), `staticTests` (below), `concurrency`, `timeoutMinutes` (default 60, per run), `maxFilesPerRun` (default 40: a wider change runs in batches, so the tool's first test run does not exhaust memory), `command` (default `npx stryker run`).

**Any other tool** (`"adapter": "command"`): give a `command` containing `{mutate}` (replaced by `file:start-end` arguments) and the `report` path, where the tool writes a [mutation-testing-report-schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema) JSON. Put the report under `.gated/` so it is not taken for a change of the item.

### Why Jest mutation runs are faster here

StrykerJS's Jest runner narrows each mutant run by test *name* only. Jest still loads every test file of the run and filters afterwards, so each mutant pays the import cost of the whole suite. On a large backend that cost is nearly all of the run.

With `"runner": "jest"` the pipeline adds a small Stryker plugin (`gated-jest`) that wraps the stock runner. The dry run already reports which file each test lives in; the plugin hands Jest only the files that cover the mutant. The mutants, the tests and the verdicts are the same. When it cannot be sure (a static mutant, an unknown test) it runs exactly as the stock runner does.

**Static mutants** (code that runs when its module loads, such as a module-level constant) have no list of covering tests, and stock Stryker runs each against every test file. By default the plugin runs them against the test files that import the mutated file, found by Jest's own dependency graph. This relies on the same assumption as `jest --findRelatedTests`: a test that never loads a module cannot observe a change in it. Set `"staticTests": "all"` to run every test file instead.

`npm run test:e2e` checks this against real Stryker and Jest: on its 32-file fixture the verdicts are identical for every mutant and the run is about 3.5 times faster. The gain grows with the number of test files and their import cost.

## How it is enforced

Hooks, all plain Node scripts:

- **PreToolUse** on file edits and shell commands denies a write that does not belong to the current stage, and says why. It also holds each agent to its job in any stage: the reviewer changes no file of the repository, the test-writer only test files, the implementer no test. Shell commands are checked for the common write forms only; the hash checks in `gp advance` are what catches the rest.
- **PreToolUse** on `AskUserQuestion` fills the approval dialog. When Claude asks `Approve spec for <item>?` or `Approve merge of <item>?`, the hook puts the text itself into the dialog's preview, read from disk: the spec file, or the item's evidence and the list of files it changes. You approve what is there, not Claude's account of it. The question carries the first digits of that text's hash.
- **PostToolUse** on `AskUserQuestion` records your approval when you answer `Approve`, tied to the hash the dialog showed.
- **Stop** reminds Claude once when it stops in the middle of a working stage. The reviewer's findings are recorded when it hands its report back (**PreToolUse** on `SubagentHandback`, which also sends back a report that lacks the closing block) or, in sessions without that tool, when it stops (**SubagentStop**).
- **SessionStart** restates the item, its stage and the next step, so a new or compacted session picks up where the item is.

Outside a worktree that holds an item, the hooks do nothing.

State is one file per worktree, `.gated/state.json`, kept out of git. Evidence is tied to content hashes: writing docs does not void the proof of the code, and any change to the code does.

### Approvals

An approval is a record of the item, what was approved (spec or merge) and the hash of that content. A spec or a tree with any other hash is not approved. The records are kept apart from the item state, in the repository's git directory (`.git/gated-approvals/`), and the item record says how each approval was given.

Two things write a record: the hook, when you answer the approval dialog, and you, in a terminal of your own:

```
cd .claude/worktrees/<item>
node <plugin>/scripts/gp.mjs approve spec     # or: approve merge
```

It prints the text, asks you to type the item name, and refuses to run without a terminal, so Claude's shell cannot use it. The guard also denies any command or file edit that names the approval records, the state file, or `approve`.

That guard reads the command's text. A model that sets out to get around it (building the path at run time, say) is stopped only by the operating system, so if you run with the [sandbox](https://code.claude.com/docs/en/sandboxing), close the folder to it. Hooks run outside the sandbox and keep working:

```json
{ "sandbox": { "filesystem": { "denyWrite": ["/absolute/path/to/your/repo/.git/gated-approvals"] } } }
```

The rest of the state file is not protected in this way: the pipeline CLI, which Claude runs, has to write it.

### Merging

`gp merge` merges only what was proven. If the base branch has moved since the item's checks ran, it first merges the base branch into the item branch and runs the item's tests and the package checks (`lint`, `typecheck`, `build`, `testAll`) on the result. If they fail, or the base branch changed a file the item also changes, the item branch is put back and nothing is merged.

## The CLI

Claude runs it for you; it is also how you inspect an item.

```
node <plugin>/scripts/gp.mjs status           where the item is and what comes next
                             spec             check the spec's form before asking for approval
                             advance          run the stage's checks and move on
                             mutate [--force] run the mutation gate
                             justify <id> <reason>
                             prove <test file> [--finding <id>]
                             back <spec|test|implementation>
                             merge
                             approve <spec|merge>   yours only, in your own terminal
                             start|init <feature|fix|hotfix> <item> [--base <branch>]
```

## Limits

- The agents default to Sonnet (test-writer, implementer) and Opus (reviewer). Edit the `model:` line in `agents/*.md` to change that.
- Mutation adapters: StrykerJS and a generic command. The per-file speed-up is for Jest; Stryker's Vitest runner already selects tests per file.
- A stopped mutation run starts over; it does not resume.
- `gp merge` merges locally and never pushes or deploys.

## Development

```
npm test            unit and integration tests (no dependencies, a few seconds)
npm run test:e2e    the whole pipeline with real Stryker and Jest (needs network)
claude --plugin-dir .   try the plugin from a checkout
```

Licensed under Apache-2.0.
