---
description: The test-writer, reading a spec without the conversation behind it, finds the boundary the spec does not place and reports it in the block the pipeline records.
runs: 2
max_turns: 12
allowed_tools: [Agent, Read, Glob, Grep]
---

Use the `gated-pipeline:test-writer` agent for its job "read the spec cold". There is no repository for this: the whole spec is below, so give it to the agent as text and tell it not to look for a spec file. Then show me the agent's report, with its closing block copied exactly.

```markdown
# Bulk discount

Orders get a discount when they are large, so that wholesale customers pay less.

### AC-1: discount on large orders
WHEN an order's total is over 100 THEN a 10% discount is applied to the total.
Example: total 200 -> 180

### AC-2: no discount on small orders
WHEN an order's total is under 100 THEN the total is unchanged.
Example: total 50 -> 50

## Out of scope
- Coupons and other discounts
```
