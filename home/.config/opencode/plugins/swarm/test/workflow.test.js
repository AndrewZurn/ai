import assert from "node:assert/strict";
import test from "node:test";
import { readWorkflow, validateWorkflow } from "../lib/workflow.js";

test("default workflow declares three mandatory reviewers and one description-selected specialist", () => {
  assert.deepEqual(readWorkflow(), {
    version: 1,
    reviewers: {
      "adversarial-reviewer": { required: true },
      "test-engineer": { required: true },
      "specification-reviewer": { required: true },
      "ui-design-reviewer": { required: false },
    },
  });
});

test("workflow rejects unknown fields, invalid IDs, ambiguous flags and empty required sets", () => {
  for (const value of [
    null, [], {}, { version: 2, reviewers: { safety: { required: true } } },
    { version: 1, reviewers: {} },
    { version: 1, reviewers: { safety: { required: false } } },
    { version: 1, reviewers: { safety: { required: "true" } } },
    { version: 1, reviewers: { safety: { required: true, after: [] } } },
    { version: 1, reviewers: { safety: { required: true }, extra: null } },
    { version: 1, reviewers: { builder: { required: true } } },
    { version: 1, reviewers: { constructor: { required: true } } },
    { version: 1, reviewers: { "../reviewer": { required: true } } },
    { version: 1, reviewers: { safety: { required: true } }, after: [] },
  ]) assert.throws(() => validateWorkflow(value), /Invalid swarm workflow/);
  const input = { version: 1, reviewers: { safety: { required: true } } };
  const copy = validateWorkflow(input);
  input.reviewers.safety.required = false;
  assert.equal(copy.reviewers.safety.required, true);
});
