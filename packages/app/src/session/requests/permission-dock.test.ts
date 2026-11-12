import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode/client/promise"
import {
  permissionLabel,
  permissionPhase,
  permissionProgress,
  permissionQueueSummary,
  permissionRemaining,
} from "./permission-dock"

const request = (action: string, resources: string[]) =>
  ({ id: `per_${action}`, sessionID: "ses_1", action, resources }) satisfies PermissionRequest

describe("permission dock", () => {
  test("clamps the remaining time between zero and the timeout", () => {
    expect(permissionRemaining(1_500, 1_000, 0)).toBe(1_000)
    expect(permissionRemaining(500, 1_000, 0)).toBe(500)
    expect(permissionRemaining(-500, 1_000, 0)).toBe(0)
  })

  test("switches phase above half and above one fifth of the timeout", () => {
    expect(permissionPhase(510, 1_000)).toBe("info")
    expect(permissionPhase(500, 1_000)).toBe("warning")
    expect(permissionPhase(210, 1_000)).toBe("warning")
    expect(permissionPhase(200, 1_000)).toBe("danger")
    expect(permissionPhase(0, 1_000)).toBe("danger")
    expect(permissionPhase(500, 0)).toBe("danger")
  })

  test("rounds labels up to whole seconds and formats minutes", () => {
    expect(permissionLabel(5_000)).toBe("5s")
    expect(permissionLabel(60_000)).toBe("1:00")
    expect(permissionLabel(80_000)).toBe("1:20")
    expect(permissionLabel(0)).toBe("0s")
  })

  test("reports a clamped progress fraction", () => {
    expect(permissionProgress(15_000, 30_000)).toBe(0.5)
    expect(permissionProgress(60_000, 30_000)).toBe(1)
    expect(permissionProgress(-1, 30_000)).toBe(0)
    expect(permissionProgress(0, 0)).toBe(0)
  })

  test("summarizes queued permissions from their action and resources", () => {
    expect(permissionQueueSummary(request("read", [".env"]))).toBe("Read .env")
    expect(permissionQueueSummary(request("shell", ["bun test", "bun run typecheck"]))).toBe(
      "$ bun test && bun run typecheck",
    )
    expect(permissionQueueSummary(request("webfetch", ["https://example.com"]))).toBe(
      "webfetch https://example.com",
    )
    expect(permissionQueueSummary(request("webfetch", []))).toBe("webfetch")
  })
})
