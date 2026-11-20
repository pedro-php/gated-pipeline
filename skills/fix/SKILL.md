---
name: fix
description: Fix a bug through the gated pipeline, starting from a test that reproduces it, then implementation, validation with mutation testing and review, and docs, with user approval of the spec and of the merge.
argument-hint: <the bug: what happens, what should happen>
disable-model-invocation: true
---

# /fix

The user wants this bug fixed through the gated pipeline:

$ARGUMENTS

The pipeline CLI is `gated`, on your PATH while the plugin is enabled. If the shell does not find it (in a subagent, say), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gp.mjs"` with the same arguments.

Read `${CLAUDE_PLUGIN_ROOT}/reference/pipeline.md` now, in full, and follow it from "Starting" with item type `fix`. A fix goes through the same five stages as a feature, with these differences:

- **Find the cause before writing the spec.** Reproduce the bug, or trace it in the code, until you can say what goes wrong and where. A spec written from the symptom alone tends to fix the symptom.
- **The interview is about the bug**: how to reproduce it, what the user expected instead, since when, and what else must keep working. Skip questions the report already answers.
- **The spec states the corrected behaviour.** `AC-1` is the regression itself: `WHEN <the steps that trigger the bug> THEN <what should happen>`, with the failing input as its example. Add an AC for each neighbouring case the cause also breaks. Put the cause in the opening paragraph.
- **The RED test reproduces the bug.** It must fail on the current code for the reason the user reported, which is what proves the fix later.

If the report above is empty, ask the user what is going wrong before starting.
