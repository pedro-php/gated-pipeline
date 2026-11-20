---
type: llm
weight: 2
---

The spec says what happens for totals over 100 and under 100, and nothing for a total of exactly 100.

PASS if the response contains an `UNCLEAR:` line saying that the spec does not say what happens when the total is exactly 100 (or that the boundary at 100 is not placed).
FAIL if no `UNCLEAR:` line is about the total of exactly 100, or if the response says the spec is clear.
