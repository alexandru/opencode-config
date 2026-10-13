import { Rpc } from "@opencode/schema/rpc"
import { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import { Snapshot } from "./src/model.ts"

export const TodoRpc = Rpc.define({
  id: "session-todo",
  methods: {
    read: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Session.ID })),
      output: Schema.toStandardSchemaV1(Snapshot),
      errors: { storage: Schema.toStandardSchemaV1(Schema.Struct({ message: Schema.String })) },
    },
  },
  events: {
    updated: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Session.ID })),
    },
  },
})
