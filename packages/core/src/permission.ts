export * as Permission from "./permission.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Clock, Context, Deferred, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { Permission } from "@opencode/schema/permission"
import type { Tool } from "@opencode/schema/tool"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { Agent } from "./agent.js"
import { SessionErrors } from "./session/error.js"
import { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { Wildcard } from "./util/wildcard.js"
import { PermissionSaved } from "./permission/saved.js"
import { PluginHooks } from "./plugin/hooks.js"
import { Flag } from "./flag.js"
import { KeyedMutex } from "./effect/keyed-mutex.js"

const PermissionEffect = Permission.Effect
export { PermissionEffect as Effect }
export { Rule, Ruleset } from "@opencode/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export interface AssertInput extends Omit<Request, "id" | "message" | "timeout" | "expires"> {
  readonly id?: ID
  readonly agent?: Agent.ID
}

/** The requester fields of a permission request made by a tool call. */
export const invocation = (context: Pick<Tool.Context, "sessionID" | "agent" | "messageID" | "id">) => ({
  sessionID: context.sessionID,
  agent: context.agent,
  source: { type: "tool" as const, messageID: context.messageID, id: context.id },
})

export interface ReplyInput {
  readonly requestID: ID
  readonly reply: Reply
  readonly message?: string
}

export interface AskResult {
  readonly id: ID
  readonly effect: Permission.Effect
}

export { Event } from "@opencode/schema/permission"

/**
 * Rules that settle a request which would otherwise ask, for work nobody is present to answer, such as a schedule's
 * check. A request they do not allow is denied. Configured denies still win, as they are evaluated first.
 */
export const Unattended = Context.Reference<Permission.Ruleset | undefined>("@opencode/Permission/Unattended", {
  defaultValue: () => undefined,
})

export class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedError<CorrectedError>()("Permission.CorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return this.feedback
  }
}

export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
  reason: Schema.String.pipe(Schema.optional),
}) {
  override get message() {
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  /** Fails only when the rules deny the request; never asks the user. */
  readonly assertNotDenied: (input: AssertInput) => Effect.Effect<void, BlockedError | SessionErrors.NotFoundError>
  /** True only when the rules already allow the request; never asks the user. */
  readonly allows: (input: AssertInput) => Effect.Effect<boolean, SessionErrors.NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: Agent.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
  timer?: Fiber.Fiber<void>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const hooks = yield* PluginHooks.Service
    const flags = yield* Flag.Service
    const scope = yield* Effect.scope
    const pending = new Map<ID, Pending>()
    const queue = KeyedMutex.makeUnsafe<SessionSchema.ID>()
    let savedRevision = 0
    let closed = false

    const cancelTimer = (item: Pending) => (item.timer === undefined ? Effect.void : Fiber.interrupt(item.timer))

    const close = Effect.gen(function* () {
      closed = true
      const items = Array.from(pending.values())
      pending.clear()
      yield* Effect.forEach(items, (item) =>
        cancelTimer(item).pipe(
          Effect.andThen(
            bus.publish(Permission.Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "reject",
            }),
          ),
          Effect.ensuring(Deferred.fail(item.deferred, new DeclinedError())),
        ),
      )
    }).pipe(Effect.uninterruptible)
    yield* Effect.addFinalizer(() => close)

    const savedRules = Effect.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({
          action: item.action,
          resource: item.resource,
          effect: "allow",
        }),
      )
    })

    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? [])
    })

    function denied(input: Pick<Request, "action" | "resources">, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const matched = input.resources.map((resource) => evaluate(input.action, resource, all))
      const effect: Permission.Effect = matched.some((rule) => rule.effect === "ask") ? "ask" : "allow"
      const timeouts = matched.flatMap((rule) => {
        if (rule.effect !== "ask" || rule.timeout === undefined) return []
        const millis = Permission.timeoutMillis(rule.timeout)
        return millis === undefined ? [] : [millis]
      })
      const timeout = timeouts.length === 0 ? undefined : Math.min(...timeouts)
      const event = yield* hooks.trigger("permission", "evaluate", {
        sessionID: input.sessionID,
        agent: input.agent,
        action: input.action,
        resources: input.resources,
        metadata: input.metadata,
        source: input.source,
        effect,
      })
      const unattended = yield* Unattended
      if (event.effect !== "ask" || unattended === undefined)
        return { effect: event.effect, message: event.message, rules: all, timeout }
      const settled = [...all, ...unattended]
      const allowed = input.resources.every((resource) => evaluate(input.action, resource, settled).effect === "allow")
      if (allowed) return { effect: "allow" as const, rules: all }
      return {
        effect: "deny" as const,
        message: `Permission ${input.action} needs approval, and nobody is present to give it`,
        rules: all,
      }
    })

    function request(input: AssertInput, message?: string, timeout?: number): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        // Tools copy optional inputs straight into metadata; undefined values are not JSON and would
        // fail the HttpApi response encoder when clients list pending requests.
        metadata:
          input.metadata &&
          Object.fromEntries(Object.entries(input.metadata).filter(([, value]) => value !== undefined)),
        source: input.source,
        message,
        timeout,
      }
    }

    const expire = (id: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const item = pending.get(id)
          if (!item || item.request.timeout === undefined) return
          pending.delete(id)
          const feedback = `Permission ${item.request.action} timed out after ${Duration.format(
            Duration.millis(item.request.timeout),
          )}; nobody answered. Continue without this action or ask again.`
          yield* bus.publish(Permission.Event.Replied, {
            sessionID: item.request.sessionID,
            requestID: item.request.id,
            reply: "reject",
            reason: "timeout",
          }).pipe(Effect.ensuring(Deferred.fail(item.deferred, new CorrectedError({ feedback }))))
        }),
      )

    const create = (request: Request, agent?: Agent.ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const expires =
            request.timeout === undefined ? undefined : (yield* Clock.currentTimeMillis) + request.timeout
          const value = expires === undefined ? request : { ...request, expires }
          const item: Pending = { request: value, agent, deferred }
          if (closed) {
            yield* Deferred.fail(deferred, new DeclinedError())
            return item
          }
          if (pending.has(value.id))
            return yield* Effect.die(new Error(`Duplicate pending permission ID: ${value.id}`))
          pending.set(value.id, item)
          yield* bus
            .publish(Permission.Event.Asked, value)
            .pipe(Effect.onError(() => Effect.sync(() => pending.delete(value.id))))
          if (value.timeout === undefined || !pending.has(value.id)) return item
          const remaining = Math.max(
            0,
            (value.expires ?? value.timeout) - (yield* Clock.currentTimeMillis),
          )
          item.timer = yield* Effect.sleep(Duration.millis(remaining)).pipe(
            Effect.andThen(expire(value.id)),
            Effect.forkIn(scope, { startImmediately: true, uninterruptible: false }),
          )
          if (pending.has(value.id)) return item
          yield* cancelTimer(item)
          item.timer = undefined
          return item
        }),
      )

    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      if (closed) return { id: input.id ?? ID.create(), effect: "deny" as const }
      const result = yield* evaluateInput(input)
      const value = request(input, result.message, result.timeout)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const prompt = (input: AssertInput, message?: string, timeout?: number) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const item = yield* create(request(input, message, timeout), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
            // must not convert a user's decline into model-facing tool output. The decline
            // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
            // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
            // it into ToolFailure and the model continues.
            Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
            Effect.ensuring(
              Effect.suspend(() => {
                if (!pending.delete(item.request.id)) return Effect.void
                return cancelTimer(item)
              }),
            ),
          )
        }),
      )

    const assert = Effect.fn("Permission.assert")(function* (input: AssertInput) {
      if (closed) return yield* Effect.die(new DeclinedError())
      const revision = savedRevision
      const result = yield* evaluateInput(input)
      const blocked = (value: typeof result) =>
        new BlockedError({
          rules: relevant(input, value.rules),
          permission: input.action,
          resources: input.resources,
          reason: value.message,
        })
      if (result.effect === "deny") return yield* blocked(result)
      if (result.effect === "allow") return
      if (!(yield* flags.enabled("permission_queue"))) return yield* prompt(input, result.message, result.timeout)

      return yield* queue.withLock(input.sessionID)(
        Effect.gen(function* () {
          if (closed) return yield* Effect.die(new DeclinedError())
          const current = savedRevision === revision ? result : yield* evaluateInput(input)
          if (current.effect === "deny") return yield* blocked(current)
          if (current.effect === "allow") return
          return yield* prompt(input, current.message, current.timeout)
        }),
      )
    })

    const assertNotDenied = Effect.fn("Permission.assertNotDenied")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      if (result.effect !== "deny") return
      return yield* new BlockedError({
        rules: relevant(input, result.rules),
        permission: input.action,
        resources: input.resources,
        reason: result.message,
      })
    })

    const allows = Effect.fn("Permission.allows")(function* (input: AssertInput) {
      if (closed) return false
      return (yield* evaluateInput(input)).effect === "allow"
    })

    const reply = Effect.fn("Permission.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          pending.delete(input.requestID)
          // Reject settles the whole session batch, so claim every member before the first yield.
          const batch =
            input.reply === "reject"
              ? Array.from(pending.entries()).filter(
                  ([, item]) => item.request.sessionID === existing.request.sessionID,
                )
              : []
          for (const [id] of batch) pending.delete(id)

          yield* cancelTimer(existing)
          const replyValue =
            input.reply === "always" && existing.request.save?.length
              ? yield* saved
                  .add({
                    projectID: location.project.id,
                    action: existing.request.action,
                    resources: existing.request.save,
                  })
                  .pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        savedRevision++
                      }),
                    ),
                    Effect.as("always" as const),
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to save permission approval", {
                        requestID: existing.request.id,
                        cause,
                      }).pipe(Effect.as("once" as const)),
                    ),
                  )
              : input.reply
          yield* bus.publish(Permission.Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: replyValue,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            for (const [, item] of batch) {
              yield* cancelTimer(item)
              yield* bus.publish(Permission.Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              // Feedback applies to the whole batch, so parallel asks don't end the step.
              yield* Deferred.fail(
                item.deferred,
                input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
              )
            }
            return
          }

          yield* Deferred.succeed(existing.deferred, undefined)
          if (replyValue !== "always" || !existing.request.save?.length) return

          for (const [id, item] of pending) {
            const result = yield* evaluateInput({ ...item.request, agent: item.agent }).pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.undefined),
            )
            if (result?.effect !== "allow") continue
            if (!pending.delete(id)) continue
            yield* cancelTimer(item)
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
          }
        }),
      ),
    )

    const list = Effect.fn("Permission.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = Effect.fn("Permission.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, assertNotDenied, allows, reply, get, forSession, list, close })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    Location.node,
    Agent.node,
    SessionStore.node,
    PermissionSaved.node,
    PluginHooks.node,
    Flag.node,
  ],
})
