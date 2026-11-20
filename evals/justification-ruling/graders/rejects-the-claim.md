---
type: llm
weight: 2
---

The justification is false. For an age of exactly 18 the original (`age >= 18`) returns true and the mutant (`age > 18`) returns false, so a test with the input 18 kills the mutant.

PASS if the response rules the mutant KILLABLE and names 18 as the input that tells the two versions apart.
FAIL if the response rules it EQUIVALENT, accepts the justification, or calls it killable without naming an input.
