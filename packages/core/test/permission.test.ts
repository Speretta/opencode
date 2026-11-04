import { describe, expect, test } from "bun:test"
import { Cause, Clock, Deferred, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionTable } from "@opencode/core/permission/sql"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { ShellParse } from "@opencode/core/shell/parse"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)
const failingSaved = Layer.succeed(
  PermissionSaved.Service,
  PermissionSaved.Service.of({
    list: () => Effect.succeed([]),
    add: () => Effect.die(new Error("saved permission unavailable")),
    update: () => Effect.die(new Error("saved permission unavailable")),
    remove: () => Effect.void,
  }),
)
const itFailingSaved = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, Permission.node]),
    [Location.node.replace(current), PermissionSaved.node.replace(failingSaved)],
  ),
)

function setup(rules: Permission.Ruleset = [], sessionID = Session.ID.make("ses_test")) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: Agent.ID.make("test"),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<Permission.AssertInput> = {}) {
  return {
    id: Permission.ID.create("per_test"),
    sessionID: Session.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies Permission.AssertInput
}

function waitForRequest(input: Partial<Permission.AssertInput> = {}) {
  return Effect.gen(function* () {
    const value = assertion(input)
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as Permission.Request
      return request.id === value.id ? Deferred.succeed(asked, request).pipe(Effect.asVoid) : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(value).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

function watchReplies() {
  return Effect.gen(function* () {
    const bus = yield* Bus.Service
    const replies: Array<{ requestID: Permission.ID; reply: Permission.Reply; reason?: string }> = []
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Permission.Event.Replied.type) return Effect.void
      const data = event.data as { requestID: Permission.ID; reply: Permission.Reply; reason?: string }
      return Effect.sync(() => {
        replies.push(data)
      })
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    return replies
  })
}

function watchEvents() {
  return Effect.gen(function* () {
    const bus = yield* Bus.Service
    const events: Array<{ type: string; requestID: Permission.ID; reply?: Permission.Reply; reason?: string }> = []
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type === Permission.Event.Asked.type) {
        const data = event.data as Permission.Request
        return Effect.sync(() => {
          events.push({ type: event.type, requestID: data.id })
        })
      }
      if (event.type === Permission.Event.Replied.type) {
        const data = event.data as { requestID: Permission.ID; reply: Permission.Reply; reason?: string }
        return Effect.sync(() => {
          events.push({ type: event.type, requestID: data.requestID, reply: data.reply, reason: data.reason })
        })
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    return events
  })
}

describe("Permission", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("checks for a deny without asking", () =>
    Effect.gen(function* () {
      yield* setup([])
      const service = yield* Permission.Service
      yield* service.assertNotDenied(assertion())
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.assertNotDenied(assertion()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
    }),
  )

  it.effect("reports whether a request is already allowed without asking", () =>
    Effect.gen(function* () {
      yield* setup([])
      const service = yield* Permission.Service
      expect(yield* service.allows(assertion())).toBe(false)
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "allow" }])
      expect(yield* service.allows(assertion())).toBe(true)
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.allows(assertion())).toBe(false)
    }),
  )

  test("matches Windows rule resources against slash-normalized file access resources", () => {
    const rules: Permission.Ruleset = [
      { action: "external_directory", resource: "C:\\Users\\x\\proj\\*", effect: "allow" },
    ]
    expect(Permission.evaluate("external_directory", "C:/Users/x/proj/src/*", rules).effect).toBe("allow")
    expect(Permission.evaluate("external_directory", "C:/Users/x/other/*", rules).effect).toBe("ask")
  })

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "custom", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "custom", resources: ["*"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.remove(Agent.ID.make("test"))
        editor.remove(Agent.ID.make("build"))
      })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("merges session rules after agent rules and before saved approvals", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      const service = yield* Permission.Service
      const setSession = (permission: Permission.Ruleset) =>
        db
          .update(SessionTable)
          .set({ permission })
          .where(eq(SessionTable.id, Session.ID.make("ses_test")))
          .run()
          .pipe(Effect.orDie)

      yield* setSession([{ action: "edit", resource: "/original/**", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "edit", resources: ["/original/src/index.ts"] }))).toMatchObject({
        effect: "deny",
      })

      yield* setRules([])
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })
      yield* setSession([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "deny" })
      yield* setSession([{ action: "bash", resource: "*", effect: "ask" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(Session.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("stamps the matched timeout and deadline on the request", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "30s" }])
      const before = yield* Clock.currentTimeMillis
      const { request } = yield* waitForRequest()
      expect(request.timeout).toBe(30_000)
      expect(request.expires).toBe(before + 30_000)
    }),
  )

  it.effect("expires an unanswered assertion with a timeout reason", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "30s" }])
      const replies = yield* watchReplies()
      const { service, fiber, request } = yield* waitForRequest()
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(30))

      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Permission.CorrectedError)
      expect(error).toMatchObject({
        feedback: "Permission read timed out after 30s; nobody answered. Continue without this action or ask again.",
      })
      expect(yield* service.list()).toEqual([])
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ requestID: request.id, reply: "reject", reason: "timeout" })
    }),
  )

  it.effect("expires an ask-only request because the timer lives on the request", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "250ms" }])
      const replies = yield* watchReplies()
      const service = yield* Permission.Service
      const result = yield* service.ask(assertion())
      expect(result.effect).toBe("ask")
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(250))

      expect(yield* service.list()).toEqual([])
      expect(yield* service.reply({ requestID: result.id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(
        Permission.NotFoundError,
      )
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ requestID: result.id, reply: "reject", reason: "timeout" })
    }),
  )

  it.effect("cancels the timer when a reply settles the request first", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "30s" }])
      const replies = yield* watchReplies()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      yield* TestClock.adjust(Duration.seconds(30))
      yield* Effect.yieldNow

      expect(yield* service.list()).toEqual([])
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ requestID: request.id, reply: "once" })
      expect(replies[0]?.reason).toBeUndefined()
    }),
  )

  it.effect("publishes permission.asked before a 1ms timeout reply", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "1ms" }])
      const events = yield* watchEvents()
      const { fiber, request } = yield* waitForRequest()
      expect(events).toEqual([{ type: Permission.Event.Asked.type, requestID: request.id }])
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(1))
      yield* Fiber.join(fiber).pipe(Effect.flip)

      expect(events.map((event) => event.type)).toEqual([
        Permission.Event.Asked.type,
        Permission.Event.Replied.type,
      ])
      expect(events[1]).toMatchObject({ requestID: request.id, reply: "reject", reason: "timeout" })
    }),
  )

  it.effect("rejects a same-session batch once and cancels both timers", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "30s" }])
      const replies = yield* watchReplies()
      const first = yield* waitForRequest({
        id: Permission.ID.create("per_first"),
        resources: ["src/first.ts"],
      })
      const second = yield* waitForRequest({
        id: Permission.ID.create("per_second"),
        resources: ["src/second.ts"],
      })
      yield* first.service.reply({ requestID: first.request.id, reply: "reject", message: "not now" })
      const firstError = yield* Fiber.join(first.fiber).pipe(Effect.flip)
      const secondError = yield* Fiber.join(second.fiber).pipe(Effect.flip)

      expect(firstError).toBeInstanceOf(Permission.CorrectedError)
      expect(secondError).toBeInstanceOf(Permission.CorrectedError)
      expect(firstError).toMatchObject({ feedback: "not now" })
      expect(secondError).toMatchObject({ feedback: "not now" })
      expect(yield* first.service.list()).toEqual([])
      expect(replies).toHaveLength(2)
      expect(replies.map((reply) => reply.requestID).sort()).toEqual(
        [first.request.id, second.request.id].sort(),
      )
      for (const reply of replies) {
        expect(reply.reply).toBe("reject")
        expect(reply.reason).toBeUndefined()
      }

      yield* TestClock.adjust(Duration.seconds(30))
      yield* Effect.yieldNow
      expect(replies).toHaveLength(2)
    }),
  )

  it.effect("settles a batch rejection and a timeout exactly once", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "read", resource: "fast/*", effect: "ask", timeout: "10ms" },
        { action: "read", resource: "slow/*", effect: "ask", timeout: "1m" },
      ])
      const replies = yield* watchReplies()
      const fast = yield* waitForRequest({
        id: Permission.ID.create("per_fast"),
        resources: ["fast/file.ts"],
      })
      const slow = yield* waitForRequest({
        id: Permission.ID.create("per_slow"),
        resources: ["slow/file.ts"],
      })
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(10))

      expect(yield* fast.service.list()).toEqual([slow.request])
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ requestID: fast.request.id, reply: "reject", reason: "timeout" })

      yield* slow.service.reply({ requestID: slow.request.id, reply: "reject" })
      yield* Fiber.await(slow.fiber)
      expect(replies).toHaveLength(2)
      expect(replies.map((reply) => reply.requestID).sort()).toEqual([fast.request.id, slow.request.id].sort())
      expect(yield* slow.service.reply({ requestID: fast.request.id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(
        Permission.NotFoundError,
      )
    }),
  )

  it.effect("close settles pending requests once and cancels their timers", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "30s" }])
      const replies = yield* watchReplies()
      const { service, request } = yield* waitForRequest()
      yield* service.close

      expect(yield* service.list()).toEqual([])
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ requestID: request.id, reply: "reject" })
      yield* TestClock.adjust(Duration.seconds(30))
      yield* Effect.yieldNow
      expect(replies).toHaveLength(1)
      expect(yield* service.reply({ requestID: request.id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(
        Permission.NotFoundError,
      )
    }),
  )

  it.effect("interruption removes the request and cancels its timer", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "30s" }])
      const replies = yield* watchReplies()
      const { service, fiber } = yield* waitForRequest()
      yield* Fiber.interrupt(fiber)

      expect(yield* service.list()).toEqual([])
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(30))
      expect(replies).toEqual([])
    }),
  )

  it.effect("always auto-approval cancels the timers of settled requests", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "30s" }])
      const replies = yield* watchReplies()
      const first = yield* waitForRequest({
        id: Permission.ID.create("per_first"),
        save: ["src/*"],
      })
      const second = yield* waitForRequest({
        id: Permission.ID.create("per_second"),
        resources: ["src/next.ts"],
      })

      yield* first.service.reply({ requestID: first.request.id, reply: "always" })
      yield* Fiber.join(first.fiber)
      yield* Fiber.join(second.fiber)
      expect(yield* second.service.list()).toEqual([])
      expect(replies).toHaveLength(2)
      expect(replies).toMatchObject([
        { requestID: first.request.id, reply: "always" },
        { requestID: second.request.id, reply: "always" },
      ])

      yield* TestClock.adjust(Duration.seconds(30))
      yield* Effect.yieldNow
      expect(replies).toHaveLength(2)
    }),
  )

  itFailingSaved.effect("settles always even when saving the approval fails", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "30s" }])
      const replies = yield* watchReplies()
      const { service, fiber, request } = yield* waitForRequest({ save: ["src/*"] })
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      expect(yield* service.list()).toEqual([])
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ requestID: request.id, reply: "always" })
      yield* TestClock.adjust(Duration.seconds(30))
      yield* Effect.yieldNow
      expect(replies).toHaveLength(1)
    }),
  )

  it.effect("keeps batch rejection isolated to one session", () =>
    Effect.gen(function* () {
      const rules: Permission.Ruleset = [{ action: "read", resource: "*", effect: "ask", timeout: "30s" }]
      yield* setup(rules)
      yield* setup(rules, Session.ID.make("ses_other"))
      const replies = yield* watchReplies()
      const first = yield* waitForRequest()
      const other = yield* waitForRequest({
        id: Permission.ID.create("per_other"),
        sessionID: Session.ID.make("ses_other"),
      })

      yield* first.service.reply({ requestID: first.request.id, reply: "reject" })
      expect(yield* first.service.list()).toEqual([other.request])
      expect(replies).toHaveLength(1)
      yield* other.service.reply({ requestID: other.request.id, reply: "once" })
      yield* Fiber.join(other.fiber)
      expect(yield* other.service.list()).toEqual([])
    }),
  )

  it.effect("expires one of two requests and leaves the other pending", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "read", resource: "fast/*", effect: "ask", timeout: "10ms" },
        { action: "read", resource: "slow/*", effect: "ask", timeout: "30s" },
      ])
      const replies = yield* watchReplies()
      const fast = yield* waitForRequest({
        id: Permission.ID.create("per_fast"),
        resources: ["fast/file.ts"],
      })
      const slow = yield* waitForRequest({
        id: Permission.ID.create("per_slow"),
        resources: ["slow/file.ts"],
      })
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(10))
      expect(yield* slow.service.list()).toEqual([slow.request])
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ requestID: fast.request.id, reason: "timeout" })

      yield* TestClock.adjust(Duration.seconds(30))
      yield* Fiber.await(slow.fiber)
      expect(yield* slow.service.list()).toEqual([])
      expect(replies).toHaveLength(2)
      expect(replies[1]).toMatchObject({ requestID: slow.request.id, reason: "timeout" })
    }),
  )

  it.effect("keeps the timer alive after the creating request scope closes", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask", timeout: "10ms" }])
      const replies = yield* watchReplies()
      const service = yield* Permission.Service
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          return yield* service.ask(assertion())
        }),
      )
      expect(result.effect).toBe("ask")
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(10))

      expect(yield* service.list()).toEqual([])
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ requestID: result.id, reply: "reject", reason: "timeout" })
    }),
  )

  it.effect("ignores a timeout on rules that deny", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "read", resource: "*", effect: "ask", timeout: "30s" },
        { action: "read", resource: "*", effect: "deny", timeout: "1ms" },
      ])
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("ignores a timeout on rules that allow", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow", timeout: "1ms" }])
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* TestClock.adjust(Duration.millis(1))
      expect(yield* service.list()).toEqual([])
    }),
  )

  for (const scenario of [
    {
      name: "uses a specific timeout that follows a broad rule",
      rules: [
        { action: "shell", resource: "*", effect: "ask", timeout: "10m" },
        { action: "shell", resource: "git push *", effect: "ask", timeout: "30s" },
      ] satisfies Permission.Ruleset,
      expected: 30_000,
    },
    {
      name: "uses the last matching timeout even when it is longer",
      rules: [
        { action: "shell", resource: "*", effect: "ask", timeout: "30s" },
        { action: "shell", resource: "git push *", effect: "ask", timeout: "60s" },
      ] satisfies Permission.Ruleset,
      expected: 60_000,
    },
    {
      name: "lets a later broad rule override an earlier specific timeout",
      rules: [
        { action: "shell", resource: "git push *", effect: "ask", timeout: "60s" },
        { action: "shell", resource: "git *", effect: "ask", timeout: "10s" },
      ] satisfies Permission.Ruleset,
      expected: 10_000,
    },
  ]) {
    it.effect(scenario.name, () =>
      Effect.gen(function* () {
        yield* setup(scenario.rules)
        const { request } = yield* waitForRequest({ action: "shell", resources: ["git push --force"] })
        expect(request.timeout).toBe(scenario.expected)
      }),
    )
  }

  it.effect("uses the shortest timeout among the winning ask rules across resources", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "read", resource: "src/*", effect: "ask", timeout: "5m" },
        { action: "read", resource: "docs/*", effect: "ask", timeout: "10s" },
      ])
      const { request } = yield* waitForRequest({ resources: ["src/index.ts", "docs/intro.md"] })
      expect(request.timeout).toBe(10_000)
    }),
  )

  it.effect("keeps a defined winner when another resource asks without a timeout", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "read", resource: "src/*", effect: "ask", timeout: "10s" },
        { action: "read", resource: "docs/*", effect: "ask" },
      ])
      const { request } = yield* waitForRequest({ resources: ["src/index.ts", "docs/intro.md"] })
      expect(request.timeout).toBe(10_000)
    }),
  )

  it.effect("leaves the timeout undefined when no winning ask rule defines one", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask" }])
      const { request } = yield* waitForRequest()
      expect(request.timeout).toBeUndefined()
      expect(request.expires).toBeUndefined()
    }),
  )

  for (const timeout of ["0s", "-2 seconds", "Infinity"]) {
    it.effect(`ignores the invalid timeout ${timeout}`, () =>
      Effect.gen(function* () {
        yield* setup([{ action: "read", resource: "*", effect: "ask", timeout }])
        const { service, fiber, request } = yield* waitForRequest()
        expect(request.timeout).toBeUndefined()
        expect(request.expires).toBeUndefined()
        yield* Effect.yieldNow
        yield* TestClock.adjust(Duration.seconds(1))
        expect(yield* service.list()).toEqual([request])
        yield* service.reply({ requestID: request.id, reply: "once" })
        yield* Fiber.join(fiber)
      }),
    )
  }

  it.effect("drops undefined metadata values so pending requests encode as JSON", () =>
    Effect.gen(function* () {
      yield* setup()
      // Tools copy optional model inputs straight into metadata, so omitted inputs arrive as undefined values.
      const { service, request } = yield* waitForRequest({
        action: "glob",
        resources: ["/project"],
        metadata: { root: "/project", path: undefined, hidden: undefined, limit: undefined },
      })
      expect(request.metadata).toStrictEqual({ root: "/project" })
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      // HttpApi encodes JSON success bodies through Schema.toCodecJson, which rejects undefined values in Unknown.
      const encode = Schema.encodeEffect(Schema.toCodecJson(Schema.Struct({ data: Schema.Array(Permission.Request) })))
      expect(yield* encode({ data: yield* service.forSession(request.sessionID) })).toEqual({
        data: [
          {
            id: request.id,
            sessionID: request.sessionID,
            action: "glob",
            resources: ["/project"],
            metadata: { root: "/project" },
          },
        ],
      })
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Asked.type
          ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toMatchObject([
        { id, projectID: Project.ID.global, action: "read", resource: "src/*" },
      ])
      yield* service.assert(assertion({ id: Permission.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("edits saved approvals and enforces the edited rule", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      const service = yield* Permission.Service
      yield* saved.add({ projectID: Project.ID.global, action: "read", resources: ["src/*", "docs/*"] })
      const src = (yield* saved.list()).find((item) => item.resource === "src/*")

      expect(yield* saved.update({ id: src!.id, resource: "src/allowed.ts" })).toMatchObject({
        id: src!.id,
        projectID: Project.ID.global,
        action: "read",
        resource: "src/allowed.ts",
      })
      expect(
        yield* service.ask(assertion({ id: Permission.ID.create("per_allowed"), resources: ["src/allowed.ts"] })),
      ).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ id: Permission.ID.create("per_other"), resources: ["src/other.ts"] })),
      ).toMatchObject({ effect: "ask" })

      expect(yield* saved.update({ id: src!.id, resource: "docs/*" }).pipe(Effect.flip)).toMatchObject({
        _tag: "PermissionSaved.ConflictError",
        id: src!.id,
        resource: "docs/*",
      })
      expect(
        yield* saved.update({ id: PermissionSaved.ID.make("psv_missing"), action: "edit" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "PermissionSaved.NotFoundError" })
    }),
  )

  for (const guard of ["configured deny", "missing Session"] as const) {
    it.effect(`skips pending auto-approval after always for ${guard}`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setup([], Session.ID.make("ses_other"))
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(Agent.ID.make("reviewer"), (agent) => {
            agent.permissions = []
          }),
        )
        const selected = yield* waitForRequest({ save: ["src/*"] })
        const other = yield* waitForRequest({
          id: Permission.ID.create("per_other"),
          sessionID: Session.ID.make("ses_other"),
          agent: Agent.ID.make("reviewer"),
        })
        if (guard === "configured deny") {
          yield* agents.transform((editor) =>
            editor.update(Agent.ID.make("reviewer"), (agent) => {
              agent.permissions = [{ action: "read", resource: "*", effect: "deny" }]
            }),
          )
        }
        if (guard === "missing Session") {
          const { db } = yield* Database.Service
          yield* db.delete(SessionTable).where(eq(SessionTable.id, other.request.sessionID)).run().pipe(Effect.orDie)
        }
        yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
        yield* Fiber.join(selected.fiber)
        expect(yield* selected.service.list()).toEqual([other.request])
        expect(other.fiber.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(other.fiber)
        expect(yield* selected.service.list()).toEqual([])
      }),
    )
  }
})

describe("shell scanner permission impact", () => {
  // Fixed cases require matching outcomes; remaining differences are investigation snapshots, not contracts.
  // These service-level cases all have command resources; tool tests cover skipped checks and directories.
  // Outcome pairs are [legacy, native].
  for (const fixture of [
    {
      name: "timed command preserves wrapper approvals",
      shell: "bash",
      command: "time -p git status",
      approved: ["time *"],
      exact: ["time -p git status"],
      denied: "time -p git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "coprocess command preserves wrapper approvals",
      shell: "bash",
      command: "coproc git status",
      approved: ["coproc *"],
      exact: ["coproc git status"],
      denied: "coproc git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "declarations and unset",
      shell: "bash",
      command: "export X=value; unset X; git status",
      approved: ["git status *"],
      exact: ["git status"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export with an approved command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export retains checks on the command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "git describe *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a conditional list",
      shell: "bash",
      command: "printf ok && git status > output",
      approved: ["printf *", "git status *"],
      exact: ["printf ok", "git status"],
      denied: "git status *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a pipeline",
      shell: "bash",
      command: "printf ok | cat < input > output",
      approved: ["printf *", "cat *"],
      exact: ["printf ok", "cat"],
      denied: "cat *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "assignment redirect followed by a command",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      approved: ["printf *"],
      exact: ["printf done"],
      denied: "FOO=bar > output",
      savedEffect: ["ask", "ask"],
      exactEffect: ["ask", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "assignment redirect with an approved command substitution",
      shell: "bash",
      command: "VERSION=$(git describe --tags) > build/version.txt",
      approved: ["git describe *"],
      exact: ["git describe --tags"],
      denied: "VERSION=$(git describe --tags) > build/version.txt",
      savedEffect: ["ask", "ask"],
      exactEffect: ["ask", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "substitution in a saved prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      approved: ["git *", "printf *"],
      exact: ["git $(printf diff) --stat", "printf diff"],
      denied: "git $(printf diff) --stat",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "standalone PowerShell scriptblock caller",
      shell: "pwsh",
      command: "ForEach-Object { Write-Output value }",
      approved: ["Write-Output *"],
      exact: ["Write-Output value"],
      denied: "ForEach-Object *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "tab-separated PowerShell command",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      approved: ["git status *", "Write-Output *"],
      exact: ["git status", "Write-Output done"],
      denied: "git\tstatus",
      savedEffect: ["allow", "ask"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["allow", "deny"],
    },
    {
      name: "PowerShell equals-joined argument",
      shell: "pwsh",
      command: "git --work-tree=src status",
      approved: ["git --work-tree *"],
      exact: ["git --work-tree"],
      denied: "git --work-tree",
      savedEffect: ["allow", "ask"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "allow"],
    },
    {
      name: "trailing redirect after list operator",
      shell: "bash",
      command: "true && cat > secret",
      approved: ["true *", "cat *"],
      exact: ["true", "cat"],
      denied: "* > secret*",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["allow", "deny"],
    },
    {
      name: "commandless redirect write",
      shell: "zsh",
      command: ">> ~/.zshrc <<< 'x'",
      approved: [">> *"],
      exact: [">> ~/.zshrc <<< 'x'"],
      denied: ">> *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "PowerShell .NET method invocation",
      shell: "pwsh",
      command: '[IO.File]::Delete("C:\\victim")',
      approved: ["[IO.File]::Delete(*"],
      exact: ['[IO.File]::Delete("C:\\victim")'],
      denied: "*Delete(*",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
  ] as const) {
    for (const scenario of [
      { name: "no approval", saved: [], rules: [], expected: ["ask", "ask"] },
      { name: "saved wildcard", saved: ["*"], rules: [], expected: ["allow", "allow"] },
      { name: "saved command approvals", saved: fixture.approved, rules: [], expected: fixture.savedEffect },
      {
        name: "exact configured approvals",
        saved: [],
        rules: fixture.exact.map((resource): Permission.Rule => ({ action: "shell", resource, effect: "allow" })),
        expected: fixture.exactEffect,
      },
      {
        name: "exact saved approvals",
        saved: fixture.exact,
        rules: [],
        expected: fixture.exactEffect,
      },
      {
        name: "configured deny despite saved wildcard",
        saved: ["*"],
        rules: [{ action: "shell", resource: fixture.denied, effect: "deny" }] satisfies Permission.Ruleset,
        expected: fixture.deniedEffect,
      },
    ] as const) {
      it.live(`${fixture.name}: ${scenario.name}`, () =>
        Effect.gen(function* () {
          yield* setup(scenario.rules)
          const saved = yield* PermissionSaved.Service
          yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: scenario.saved })
          const service = yield* Permission.Service

          const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project")
          expect(parsed.commands.length).toBeGreaterThan(0)
          expect(parsed.directories).toEqual([])
          const result = yield* service.ask(
            assertion({
              action: "shell",
              resources: parsed.commands.map((command) => command.resource),
              save: parsed.commands.map((command) => command.save),
            }),
          )
          expect(result.effect).toBe(scenario.expected[1])
          const pending = yield* service.list()
          expect(pending).toHaveLength(result.effect === "ask" ? 1 : 0)
          if (result.effect === "ask") {
            expect(pending[0]?.resources).toEqual(parsed.commands.map((command) => command.resource))
            expect(pending[0]?.save).toEqual(parsed.commands.map((command) => command.save))
            yield* service.reply({ requestID: result.id, reply: "once" })
            expect(yield* service.list()).toEqual([])
          }
        }),
      )
    }
  }

  // Grant/repeat rows select the granting parser; repeat columns select the parser used afterwards.
  for (const fixture of [
    {
      name: "numeric npm script prefix",
      shell: "bash",
      command: "npm run 123",
      grants: [["npm run *"], ["npm run 123 *"]],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "npm run build",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "numeric AWS option prefix",
      shell: "bash",
      command: "aws --cli-read-timeout 60 s3 ls",
      grants: [["aws --cli-read-timeout s3 *"], ["aws --cli-read-timeout 60 *"]],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "aws --cli-read-timeout 60 ec2 describe-instances",
      nextEffect: ["ask", "allow"],
    },
    {
      name: "substitution prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      grants: [
        ["git --stat *", "printf *"],
        ["git $(printf diff) *", "printf *"],
      ],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "git --stat",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "redirect prefix",
      shell: "bash",
      command: "printf ok && git status > output",
      grants: [
        ["printf *", "git status *"],
        ["printf *", "git status *"],
      ],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "git status --short",
      nextEffect: ["allow", "allow"],
    },
    {
      name: "assignment redirect prefix",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      grants: [
        ["printf *"],
        ["FOO=bar > *", "printf *"],
      ],
      repeat: [
        ["ask", "allow"],
        ["ask", "allow"],
      ],
      next: "FOO=bar rm -rf /",
      nextEffect: ["ask", "ask"],
    },
    {
      name: "PowerShell method prefix",
      shell: "pwsh",
      command: '[IO.File]::Delete("C:\\first")',
      grants: [
        ["[IO.File]::Delete(*"],
        ["[IO.File]::Delete(*"],
      ],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: '[IO.File]::WriteAllText("C:\\first", "x")',
      nextEffect: ["ask", "ask"],
    },
    {
      name: "PowerShell tab prefix",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      grants: [["Write-Output *"], ["git\tstatus *", "Write-Output *"]],
      repeat: [
        ["allow", "ask"],
        ["allow", "allow"],
      ],
      next: "git status",
      nextEffect: ["ask", "ask"],
    },
  ] as const) {
    it.live(`${fixture.name}: always allow covers repeat execution and narrows prefix scope`, () =>
      Effect.gen(function* () {
        yield* setup()
        const service = yield* Permission.Service
        const saved = yield* PermissionSaved.Service
        const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project")
        const first = yield* service.ask(
          assertion({
            action: "shell",
            resources: parsed.commands.map((command) => command.resource),
            save: parsed.commands.map((command) => command.save),
          }),
        )
        expect(first.effect).toBe("ask")
        expect(yield* service.list()).toHaveLength(1)
        yield* service.reply({ requestID: first.id, reply: "always" })
        expect(yield* service.list()).toEqual([])
        expect((yield* saved.list({ projectID: Project.ID.global })).map((rule) => rule.resource).sort()).toEqual(
          [...fixture.grants[1]].sort(),
        )

        for (const command of [fixture.command, fixture.next]) {
          const parsed = yield* ShellParse.scan(command, fixture.shell, "/project")
          const result = yield* service.ask(
            assertion({
              action: "shell",
              resources: parsed.commands.map((command) => command.resource),
              save: parsed.commands.map((command) => command.save),
            }),
          )
          expect(result.effect, command).toBe(command === fixture.next ? fixture.nextEffect[1] : fixture.repeat[1]?.[1])
          if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
          expect(yield* service.list()).toEqual([])
        }
      }),
    )
  }
})
