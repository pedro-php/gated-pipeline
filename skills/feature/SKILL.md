---
name: feature
description: Build a feature through the gated pipeline (spec, failing tests, implementation, validation with mutation testing and review, docs), in its own worktree, with user approval of the spec and of the merge.
argument-hint: <what to build>
disable-model-invocation: true
---

# /feature

The user wants this built through the gated pipeline:

$ARGUMENTS

The pipeline CLI is `gated`, on your PATH while the plugin is enabled. If the shell does not find it (in a subagent, say), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gp.mjs"` with the same arguments.

Read `${CLAUDE_PLUGIN_ROOT}/reference/pipeline.md` now, in full, and follow it from "Starting" with item type `feature`. It explains the five stages, what each gate checks, and how approvals are recorded.

If the request above is empty, ask the user what they want to build before starting.
