/** @jsxImportSource @opentui/solid */
import { expect, jest, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode/client"
import type { JSX } from "solid-js"
import { SPINNER_FRAMES } from "../../src/component/spinner"
import { BlockTool, InlineTool, ToolPart } from "../../src/routes/session/index"
import { context } from "../../src/routes/session/render-context"
import { createTimelineAnchors } from "../../src/routes/session/anchors"
import { useTheme } from "../../src/context/theme"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { renderLocal } from "../fixture/local"

const request = (id: string, sourceID: string, timeout = 60_000, expires?: number) => ({
  id,
  sessionID: "ses_test",
  action: "read",
  resources: ["src/index.ts"],
  source: { type: "tool" as const, messageID: "msg_test", id: sourceID },
  timeout,
  ...(expires === undefined ? {} : { expires }),
})

const toolRequest = (
  id: string,
  sourceID: string,
  action: string,
  resources: string[],
  timeout = 60_000,
  expires?: number,
) => ({
  id,
  sessionID: "ses_test",
  action,
  resources,
  source: { type: "tool" as const, messageID: "msg_test", id: sourceID },
  timeout,
  ...(expires === undefined ? {} : { expires }),
})

function part(id: string, state: SessionMessageAssistantTool["state"]): SessionMessageAssistantTool {
  return { type: "tool", id, name: "read", state, time: { created: 0 } }
}

function toolPart(id: string, name: string, input: Record<string, string>): SessionMessageAssistantTool {
  return { type: "tool", id, name, state: { status: "running", input, metadata: {} }, time: { created: 0 } }
}

const running = { status: "running" as const, input: { path: "src/index.ts" }, metadata: {} }
const completed: SessionMessageAssistantTool["state"] = {
  status: "completed",
  input: { path: "src/index.ts" },
  content: [{ type: "text", text: "ok" }],
  metadata: {},
}
const rejected = {
  status: "error" as const,
  input: { path: "src/index.ts" },
  error: { type: "permission.rejected", message: "not now" },
}
const timedOut = {
  status: "error" as const,
  input: { path: "src/index.ts" },
  error: {
    type: "permission.rejected",
    message: "Permission read timed out after 30s; nobody answered. Continue without this action or ask again.",
  },
}

async function mount(children: () => JSX.Element) {
  const config = createTuiResolvedConfig()
  return renderLocal({
    children: () => (
      <context.Provider
        value={{
          width: 80,
          terminal: { width: 80, height: 30 },
          sessionID: "ses_test",
          anchors: createTimelineAnchors(),
          groupExpanded: () => false,
          setGroupExpanded: () => {},
          thinkingMode: () => "hide",
          markdownMode: () => "rendered",
          groupExploration: () => true,
          legacyTurns: () => false,
          diffWrapMode: () => "word",
          models: () => [],
          messageIndex: () => undefined,
          config,
          mutatePending: async () => true,
          pendingDelivery: () => undefined,
        }}
      >
        {children()}
      </context.Provider>
    ),
  })
}

test("renders one compact row for active and queued permission tools", async () => {
  const read = toolPart("read-1", "read", { path: ".env" })
  const first = toolPart("shell-1", "shell", { command: "echo hello" })
  const second = toolPart("shell-2", "shell", { command: "echo test" })
  let theme!: ReturnType<typeof useTheme>
  function CaptureTheme() {
    theme = useTheme()
    return <box />
  }
  const setup = await mount(() => (
    <>
      <CaptureTheme />
      <box flexDirection="column">
        <ToolPart part={read} images={false} />
        <ToolPart part={first} images={false} />
        <ToolPart part={second} images={false} />
      </box>
    </>
  ))
  const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000)
  try {
    setup.renderer.start()
    setup.events.emit({
      id: "evt_queued_shells",
      created: 0,
      type: "permission.queued",
      data: {
        sessionID: "ses_test",
        requests: [
          toolRequest("per_shell_1", "shell-1", "shell", ["echo hello"]),
          toolRequest("per_shell_2", "shell-2", "shell", ["echo test"]),
        ],
      },
    })
    setup.events.emit({
      id: "evt_active_read",
      created: 0,
      type: "permission.asked",
      data: toolRequest("per_read", "read-1", "read", [".env"], 60_000, 1_060_000),
    })
    await setup.waitFor(
      () =>
        setup.data.session.permission.list("ses_test")?.length === 1 &&
        setup.data.session.permission.queued("ses_test")?.length === 2,
    )
    await setup.waitForFrame(
      (frame) => frame.includes("Read .env") && frame.includes("$ echo hello") && frame.includes("$ echo test"),
    )

    const lines = setup.captureCharFrame().split("\n")
    const summaries = ["Read .env", "$ echo hello", "$ echo test"]
    const row = summaries.map((summary) => lines.findIndex((line) => line.includes(summary)))
    expect(row.every((index) => index >= 0)).toBe(true)
    expect(row[1]).toBe(row[0] + 1)
    expect(row[2]).toBe(row[0] + 2)
    const column = lines[row[0]!]!.indexOf(summaries[0]!)
    expect(summaries.map((summary, index) => lines[row[index]!]!.indexOf(summary))).toEqual([column, column, column])

    const spans = setup.captureSpans().lines
    const summary = (index: number, text: string) =>
      spans[row[index]!]!.spans.find((span) => span.text.includes(text))
    const active = summary(0, "Read .env")
    const queuedFirst = summary(1, "$ echo hello")
    const queuedSecond = summary(2, "$ echo test")
    expect(active?.fg.toInts()).toEqual(theme.text.feedback.warning.base.toInts())
    expect(queuedFirst?.fg.toInts()).toEqual(theme.text.muted.toInts())
    expect(queuedSecond?.fg.toInts()).toEqual(theme.text.muted.toInts())

    const backgrounds = [active, queuedFirst, queuedSecond].map((span) => span?.bg.toInts())
    expect(backgrounds[0]).toEqual(backgrounds[1])
    expect(backgrounds[1]).toEqual(backgrounds[2])
    expect(backgrounds[0]).toEqual(theme.background.base.toInts())
    expect(backgrounds[0]).not.toEqual(theme.background.raised.base.toInts())

    expect(lines[row[0]!]).toContain("┃")
    expect(lines[row[1]!]).not.toContain("┃")
    expect(lines[row[2]!]).not.toContain("┃")
    const border = spans[row[0]!]!.spans.find((span) => span.text.includes("┃"))
    const warning = theme.text.feedback.warning.base
    expect(border).toBeDefined()
    const borderFG = border!.fg.toInts()
    const warningInts = warning.toInts()
    const backgroundInts = theme.background.base.toInts()
    expect(borderFG).not.toEqual(warningInts)
    for (const channel of [0, 1, 2] as const) {
      expect(borderFG[channel]).toBeGreaterThan(backgroundInts[channel]!)
      expect(borderFG[channel]).toBeLessThan(warningInts[channel]!)
    }

    expect(lines[row[0]!]).toMatch(/[○◔◑◕]/)
    expect(lines[row[1]!]).not.toMatch(/[○◔◑◕]/)
    expect(lines[row[2]!]).not.toMatch(/[○◔◑◕]/)
    expect(SPINNER_FRAMES.some((glyph) => lines[row[0]!]!.includes(glyph))).toBe(false)
    expect(SPINNER_FRAMES.some((glyph) => lines[row[1]!]!.includes(glyph))).toBe(true)
    expect(SPINNER_FRAMES.some((glyph) => lines[row[2]!]!.includes(glyph))).toBe(true)
  } finally {
    now.mockRestore()
    await setup[Symbol.asyncDispose]()
  }
})

test("shows queued, active, completed, rejected and timeout tool row states", async () => {
  const setup = await mount(() => (
    <box flexDirection="column">
      <InlineTool icon="→" complete={false} pending="" running part={part("queued-1", running)}>
        Queued one
      </InlineTool>
      <InlineTool icon="→" complete={false} pending="" running part={part("queued-2", running)}>
        Queued two
      </InlineTool>
      <InlineTool icon="→" complete={false} pending="" running part={part("active-1", running)}>
        Active tool
      </InlineTool>
      <InlineTool icon="→" complete="done" pending="" part={part("done-1", completed)}>
        Completed tool
      </InlineTool>
      <InlineTool icon="→" complete={false} pending="" part={part("rejected-1", rejected)}>
        Rejected tool
      </InlineTool>
      <InlineTool icon="→" complete={false} pending="" part={part("timeout-1", timedOut)}>
        Timed out tool
      </InlineTool>
    </box>
  ))
  const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000)
  try {
    setup.renderer.start()
    setup.events.emit({
      id: "evt_queued_1",
      created: 0,
      type: "permission.queued",
      data: {
        sessionID: "ses_test",
        requests: [request("per_queued_1", "queued-1"), request("per_queued_2", "queued-2")],
      },
    })
    setup.events.emit({
      id: "evt_asked_1",
      created: 0,
      type: "permission.asked",
      data: request("per_active_1", "active-1", 60_000, 1_060_000),
    })
    await setup.waitFor(
      () =>
        setup.data.session.permission.list("ses_test")?.length === 1 &&
        setup.data.session.permission.queued("ses_test")?.length === 2,
    )
    await setup.waitForFrame((frame) => frame.includes("Queued one") && frame.includes("Active tool"))
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Queued two")
    expect(frame).toContain("Completed tool")
    expect(frame).toContain("Rejected tool")
    expect(frame).toContain("Timed out tool")
    expect(frame).toContain("○")
    expect(frame).toContain("✕")
    expect(frame).toContain("●")
    expect(SPINNER_FRAMES.some((glyph) => frame.includes(glyph))).toBe(true)
  } finally {
    now.mockRestore()
    await setup[Symbol.asyncDispose]()
  }
})

test("shows the indicator in block tool headers", async () => {
  const setup = await mount(() => (
    <box flexDirection="column">
      <BlockTool path={{ label: "Shell", value: "echo active" }} part={part("active-shell", running)} />
      <BlockTool path={{ label: "Shell", value: "echo queued" }} part={part("queued-shell", running)} />
    </box>
  ))
  const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000)
  try {
    setup.renderer.start()
    setup.events.emit({
      id: "evt_queued_shell",
      created: 0,
      type: "permission.queued",
      data: { sessionID: "ses_test", requests: [request("per_queued_shell", "queued-shell")] },
    })
    setup.events.emit({
      id: "evt_asked_shell",
      created: 0,
      type: "permission.asked",
      data: request("per_active_shell", "active-shell", 60_000, 1_060_000),
    })
    await setup.waitFor(
      () =>
        setup.data.session.permission.list("ses_test")?.length === 1 &&
        setup.data.session.permission.queued("ses_test")?.length === 1,
    )
    await setup.waitForFrame((frame) => frame.includes("echo active") && frame.includes("echo queued"))
    const frame = setup.captureCharFrame()
    expect(frame).toContain("○")
    expect(frame).toContain("Shell")
    expect(frame).toContain("echo active")
    expect(frame).toContain("echo queued")
    expect(SPINNER_FRAMES.some((glyph) => frame.includes(glyph))).toBe(true)
  } finally {
    now.mockRestore()
    await setup[Symbol.asyncDispose]()
  }
})
