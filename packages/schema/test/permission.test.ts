import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Permission } from "../src/permission.js"

const decodeRule = Schema.decodeUnknownSync(Permission.Rule)
const encodeRule = Schema.encodeSync(Permission.Rule)

describe("permission timeouts", () => {
  test.each([
    ["10 minutes", 600_000],
    ["1.5 hours", 5_400_000],
    ["90 seconds", 90_000],
    ["250ms", 250],
    ["1s", 1_000],
    ["3.5m", 210_000],
    ["1.5h", 5_400_000],
    ["2d", 172_800_000],
  ])("decodes %s and keeps the duration string", (input, millis) => {
    const rule = decodeRule({ action: "shell", resource: "*", effect: "ask", timeout: input })
    expect(rule.timeout).toBe(input)
    expect(Permission.timeoutMillis(rule.timeout!)).toBe(millis)
    expect(encodeRule(rule)).toEqual({ action: "shell", resource: "*", effect: "ask", timeout: input })
  })

  test("rejects an unknown duration", () => {
    expect(() => decodeRule({ action: "shell", resource: "*", effect: "ask", timeout: "5 fortnights" })).toThrow()
  })

  test("round-trips non-compact durations through encode and decode", () => {
    for (const timeout of ["-2 seconds", "Infinity", "-Infinity"]) {
      const rule = decodeRule({ action: "shell", resource: "*", effect: "ask", timeout })
      expect(decodeRule(encodeRule(rule))).toEqual(rule)
    }
    expect(Permission.timeoutMillis("-2 seconds")).toBe(-2_000)
    expect(Permission.timeoutMillis("Infinity")).toBeUndefined()
    expect(Permission.timeoutMillis("-Infinity")).toBeUndefined()
  })

  test("omits an unset rule timeout when encoding", () => {
    expect(encodeRule(decodeRule({ action: "shell", resource: "*", effect: "ask" }))).toEqual({
      action: "shell",
      resource: "*",
      effect: "ask",
    })
  })

  test("carries the request budget and deadline", () => {
    const request = Schema.decodeUnknownSync(Permission.Request)({
      id: "per_test",
      sessionID: "ses_test",
      action: "shell",
      resources: ["*"],
      timeout: 60_000,
      expires: 120_000,
    })
    expect(request).toMatchObject({ timeout: 60_000, expires: 120_000 })
    expect(Schema.encodeSync(Permission.Request)(request)).toMatchObject({ timeout: 60_000, expires: 120_000 })
    expect(
      Schema.encodeSync(Permission.Request)(
        Schema.decodeUnknownSync(Permission.Request)({
          id: "per_test",
          sessionID: "ses_test",
          action: "shell",
          resources: ["*"],
        }),
      ),
    ).not.toHaveProperty("timeout")
  })

  test("marks only timeout replies with a reason", () => {
    const decode = Schema.decodeUnknownSync(Permission.Event.Replied.data)
    expect(decode({ sessionID: "ses_test", requestID: "per_test", reply: "reject", reason: "timeout" })).toMatchObject({
      reply: "reject",
      reason: "timeout",
    })
    expect(() => decode({ sessionID: "ses_test", requestID: "per_test", reply: "reject", reason: "declined" })).toThrow()
  })
})
