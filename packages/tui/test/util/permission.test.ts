import { expect, test } from "bun:test"
import {
  permissionPresentation,
  permissionTimerBar,
  permissionTimerBarCells,
  permissionTimerLabel,
  permissionTimerPhase,
  permissionTimerRemaining,
} from "../../src/util/permission"

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})

test("renders a fixed-width permission countdown label", () => {
  expect(permissionTimerLabel(0)).toBe("0s")
  expect(permissionTimerLabel(999)).toBe("1s")
  expect(permissionTimerLabel(59_999)).toBe("1:00")
  expect(permissionTimerLabel(60_000)).toBe("1:00")
  expect(permissionTimerLabel(90_000)).toBe("1:30")
  expect(permissionTimerLabel(3_600_000)).toBe("60:00")
})

test("clamps remaining time to the request budget", () => {
  expect(permissionTimerRemaining(5_000, 5_000, 4_000)).toBe(1_000)
  expect(permissionTimerRemaining(5_000, 5_000, 7_000)).toBe(0)
  expect(permissionTimerRemaining(10_000, 5_000, 4_000)).toBe(5_000)
})

test("moves the countdown through info, warning and error phases", () => {
  expect(permissionTimerPhase(51, 100)).toBe("info")
  expect(permissionTimerPhase(50, 100)).toBe("warning")
  expect(permissionTimerPhase(21, 100)).toBe("warning")
  expect(permissionTimerPhase(20, 100)).toBe("error")
  expect(permissionTimerPhase(0, 100)).toBe("error")
  expect(permissionTimerPhase(10, 0)).toBe("error")
})

test("sizes the bar from the footer width and clamps it", () => {
  expect(permissionTimerBarCells(120, false, "1:00")).toBe(60)
  expect(permissionTimerBarCells(60, false, "1:00")).toBe(45)
  expect(permissionTimerBarCells(44, false, "1:00")).toBe(29)
  expect(permissionTimerBarCells(40, false, "1:00")).toBe(27)
  expect(permissionTimerBarCells(44, true, "1:00")).toBe(29)
  expect(permissionTimerBarCells(100, true, "1:00")).toBe(60)
  expect(permissionTimerBarCells(16, false, "1:00")).toBe(3)
  expect(permissionTimerBarCells(12, false, "1:00")).toBe(0)
})

test("fills the bar proportionally with block glyphs", () => {
  expect(permissionTimerBar(60_000, 60_000, 10)).toEqual({ filled: "█".repeat(10), empty: "" })
  expect(permissionTimerBar(50_000, 60_000, 10)).toEqual({ filled: "█".repeat(9), empty: "░" })
  expect(permissionTimerBar(30_000, 60_000, 10)).toEqual({ filled: "█".repeat(5), empty: "░".repeat(5) })
  expect(permissionTimerBar(0, 60_000, 10)).toEqual({ filled: "", empty: "░".repeat(10) })
})
