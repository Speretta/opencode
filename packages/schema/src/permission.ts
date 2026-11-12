export * as Permission from "./permission.js"

import { Duration, Option, Schema } from "effect"
import { optional } from "./schema.js"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { SessionID } from "./session-id.js"
import { statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartingWith("per")).pipe(
  Schema.brand("Permission.ID"),
  Schema.annotate({ identifier: "Permission.ID" }),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Source = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    messageID: Schema.String,
    id: Schema.String,
  }),
]).annotate({ identifier: "Permission.Source" })
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: SessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  save: Schema.Array(Schema.String).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  source: Source.pipe(optional),
  message: Schema.String.pipe(optional),
  timeout: Schema.Finite.annotate({
    description: "Total time budget for this request in milliseconds, copied from the matching rule.",
  }).pipe(optional),
  expires: Schema.Finite.annotate({
    description: "Epoch milliseconds deadline for this request. Clients can render a countdown from it.",
  }).pipe(optional),
}

export const Request = Schema.Struct({
  id: ID,
  ...RequestFields,
}).annotate({ identifier: "Permission.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const Reply = Schema.Literals(["once", "always", "reject"]).annotate({ identifier: "Permission.Reply" })
export type Reply = typeof Reply.Type

const Asked = ephemeral({ type: "permission.asked", schema: Request.fields })
const Replied = ephemeral({
  type: "permission.replied",
  schema: {
    sessionID: SessionID,
    requestID: ID,
    reply: Reply,
    reason: Schema.Literal("timeout")
      .annotate({ description: 'Set to "timeout" when the request expired without a reply.' })
      .pipe(optional),
  },
})
const Queued = ephemeral({
  type: "permission.queued",
  schema: {
    sessionID: SessionID,
    requests: Schema.Array(Request).annotate({
      description: "Requests waiting in the session permission queue, in admission order.",
    }),
  },
})
export const Event = { Asked, Replied, Queued, Definitions: inventory(Asked, Replied, Queued) }

export const Effect = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "Permission.Effect" })
export type Effect = typeof Effect.Type

const timeoutUnitMillis = {
  ns: 0.000001,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const

const positiveNumber = "(?:[1-9][0-9]*(?:\\.[0-9]+)?|0*\\.[0-9]*[1-9][0-9]*)"

const compactTimeout = new RegExp(`^(${positiveNumber})\\s*(ns|ms|s|m|h|d|w)$`)

const timeoutString = new RegExp(
  `^(?:${positiveNumber}\\s*(?:ns|ms|s|m|h|d|w)|${positiveNumber}\\s+(?:nano|nanos|micro|micros|milli|millis|second|seconds|minute|minutes|hour|hours|day|days|week|weeks))$`,
)

const parseFullTimeout = Schema.decodeUnknownOption(Schema.DurationFromString)

const parseTimeout = (value: string) => {
  const compact = compactTimeout.exec(value)
  if (compact) {
    const millis = Number(compact[1]) * timeoutUnitMillis[compact[2] as keyof typeof timeoutUnitMillis]
    return Number.isFinite(millis) && millis > 0 ? Option.some(Duration.millis(millis)) : Option.none()
  }
  return parseFullTimeout(value)
}

/** Milliseconds in a positive finite timeout, or `undefined` when it is invalid. */
export const timeoutMillis = (value: string) => {
  const millis = Option.match(parseTimeout(value), {
    onNone: () => undefined,
    onSome: (duration) => Duration.toMillis(duration),
  })
  return millis !== undefined && Number.isFinite(millis) && millis > 0 ? millis : undefined
}

export interface Rule extends Schema.Schema.Type<typeof Rule> {}
export const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Effect,
  timeout: Schema.String.check(Schema.isPattern(timeoutString))
    .annotate({
      description:
        'How long an ask stays pending before it expires. Accepts duration strings such as "10 minutes", or compact values such as "250ms", "3.5m", "1.5h", or "2d". Only ask rules use it.',
    })
    .pipe(optional),
}).annotate({ identifier: "Permission.Rule" })

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "Permission.Ruleset" })
export type Ruleset = typeof Ruleset.Type
