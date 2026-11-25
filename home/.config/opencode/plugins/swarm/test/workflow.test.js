import assert from "node:assert/strict";
import test from "node:test";
import { readWorkflow, validateWorkflow } from "../lib/workflow.js";

test("default workflow declares three mandatory reviewers and one description-selected specialist", () => {
  assert.deepEqual(readWorkflow(), {
    version: 1,
    reviewers: {
      "adversarial-reviewer": {
        required: true,
        description: "Find defects, regressions, security risks, and unnecessary complexity in the implementation.",
      },
      "test-engineer": {
        required: true,
        description: "Check test coverage and independently verify behavior, including browser behavior for web changes.",
      },
      "specification-reviewer": {
        required: true,
        description: "Verify that the implementation and its evidence satisfy every task requirement.",
      },
      "ui-design-reviewer": {
        required: false,
        description: "Review web interface usability, visual design, and interaction quality in a browser.",
      },
    },
  });
});

test("workflow rejects unknown fields, invalid IDs, ambiguous flags and empty required sets", () => {
  for (const value of [
    null, [], {}, { version: 2, reviewers: { safety: { required: true, description: "Review safety." } } },
    { version: 1, reviewers: {} },
    { version: 1, reviewers: { safety: { required: false, description: "Review safety." } } },
    { version: 1, reviewers: { safety: { required: "true", description: "Review safety." } } },
    { version: 1, reviewers: { safety: { required: true, description: "Review safety.", after: [] } } },
    { version: 1, reviewers: { safety: { required: true, description: "Review safety." }, extra: null } },
    { version: 1, reviewers: { builder: { required: true, description: "Review builds." } } },
    { version: 1, reviewers: { constructor: { required: true, description: "Review safety." } } },
    { version: 1, reviewers: { "../reviewer": { required: true, description: "Review safety." } } },
    { version: 1, reviewers: { safety: { required: true, description: "Review safety." } }, after: [] },
    { version: 1, reviewers: { safety: { required: true, description: "  " } } },
  ]) assert.throws(() => validateWorkflow(value), /Invalid swarm workflow/);
  const input = { version: 1, reviewers: { safety: { required: true, description: "Review safety." } } };
  const copy = validateWorkflow(input);
  input.reviewers.safety.required = false;
  assert.equal(copy.reviewers.safety.required, true);
});
