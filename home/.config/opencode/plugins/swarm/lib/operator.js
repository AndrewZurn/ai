import { requireThat } from "./protocol.js";
import { randomUUID } from "node:crypto";

const snapshotSchema = {
  anyOf: [{ type: "null" }, { type: "object", additionalProperties: true }],
};
const errors = {
  conflict: {
    type: "object",
    properties: { reason: { type: "string" } },
    required: ["reason"],
    additionalProperties: false,
  },
};

export const operatorDefinition = {
  id: "swarm-operator",
  events: {},
  methods: {
    inspect: {
      errors: {},
      input: { type: "object", additionalProperties: false },
      output: snapshotSchema,
    },
    control: {
      output: snapshotSchema,
      input: {
        type: "object",
        properties: {
          runID: { type: "string", minLength: 1 },
          action: { type: "string", enum: ["resume", "interrupt", "cancel"] },
        },
        required: ["runID", "action"],
        additionalProperties: false,
      },
      errors,
    },
    confirm: {
      input: {
        type: "object",
        properties: {
          runID: { type: "string" }, operationID: { type: "string" },
          rootInboxEmpty: { type: "boolean", const: true },
        },
        required: ["runID", "operationID", "rootInboxEmpty"],
        additionalProperties: false,
      },
      output: snapshotSchema,
      errors,
    },
  },
};

// This is an authenticated operator surface, not an agent tool. Inspection does
// not acquire the workflow queue, recheck candidates, or enqueue model turns.
export function registerOperator(ctx, gate, definition) {
  const read = signal => gate.runtime.wait("operator inspect",
    () => gate.ctx.storage.get(gate.key), undefined, signal);
  const inspect = async (_, context) => {
    const run = await read(context.signal);
    if (!run) return null;
    return {
      runID: run.id, root: run.root, directory: run.directory,
      phase: run.phase, reason: run.reason ?? null, round: run.round,
      maxRounds: run.maxRounds, rootStopRequired: run.rootStopRequired ?? false,
      operatorStop: run.operatorStop ?? null,
      stopFailures: run.stopFailures ?? [],
      sessions: [...new Set([run.root, ...run.jobs.map(job => job.sessionID)])].map(sessionID => ({
        sessionID,
        role: sessionID === run.root ? "orchestrator"
          : run.jobs.findLast(job => job.sessionID === sessionID)?.role,
        pendingAdmissions: gate.runtime.pending(sessionID),
      })),
    };
  };
  return ctx.rpc.register(definition, {
    inspect,
    control: async (input, context) => {
      try {
        requireThat(input && typeof input.runID === "string" &&
          ["resume", "interrupt", "cancel"].includes(input.action), "Invalid operator action.");
        const run = await read(context.signal);
        requireThat(run?.id === input.runID, "The run changed; select the current run and retry.");
        await gate.control(run.root, input.action, {
          runID: input.runID, signal: context.signal,
          ...(input.action === "resume" ? {} : {
            operatorID: run.operatorStop?.id ?? randomUUID(),
          }),
        });
        return inspect({}, context);
      } catch (error) {
        return context.error("conflict", error.message, { reason: error.message });
      }
    },
    confirm: async (input, context) => {
      try {
        requireThat(input.rootInboxEmpty === true,
          "Native root inbox inspection must confirm that no queued input remains.");
        await gate.locked(async () => {
          requireThat(gate.run?.id === input.runID &&
            gate.run.operatorStop?.id === input.operationID,
          "The run or operator stop changed; inspect and retry.");
          const root = await gate.ctx.session.get({ sessionID: gate.run.root });
          requireThat(!(root.time.busy > (root.time.idle ?? 0)),
            "The orchestrator is still running; retry interrupt.");
          // The Promise plugin API has no inbox methods. This authenticated
          // operator acknowledgement follows the CLI's native inbox inspection;
          // ordinary status/resume paths cannot clear an uncertain root fence.
          gate.run.stopFailures = await gate.stopParticipants({ rootInboxConfirmed: true });
          await gate.save();
          requireThat(gate.run.stopFailures.length === 0, "Participant stops are not confirmed; retry interrupt.");
          delete gate.run.operatorStop;
          await gate.save();
        }, context.signal);
        return inspect({}, context);
      } catch (error) {
        return context.error("conflict", error.message, { reason: error.message });
      }
    },
  });
}
