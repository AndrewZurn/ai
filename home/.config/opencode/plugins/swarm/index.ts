import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { setup } from "./lib/plugin.js"
import { operatorDefinition } from "./lib/operator.js"

export default Plugin.define({
  id: "swarm",
  setup: ctx => setup(ctx, { operatorRpc: Rpc.define(operatorDefinition) }),
})
