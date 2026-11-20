---
description: The reviewer does not accept a justification for a surviving mutant when an input tells the mutant from the original, and names that input.
runs: 2
max_turns: 12
allowed_tools: [Agent, Read, Glob, Grep]
---

Use the `gated-pipeline:reviewer` agent to rule on one justified survivor. There is no repository and no spec for this: everything it needs is below, so give it to the agent as text and tell it that it only has to rule on the survivor and end with its usual closing block. Then show me the agent's report, with its closing block copied exactly.

The code, `src/age.js`:

```js
function isAdult(age) {
  return age >= 18;
}
```

The existing tests: `expect(isAdult(30)).toBe(true)` and `expect(isAdult(5)).toBe(false)`.

The surviving mutant, id `src/age.js:2:10:EqualityOperator:1f2e3d4c`: `age >= 18` was changed to `age > 18`.

The justification on record: "Equivalent mutant: the change makes no observable difference, so no test can kill it."
