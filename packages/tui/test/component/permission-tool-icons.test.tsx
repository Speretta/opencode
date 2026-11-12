/** @jsxImportSource @opentui/solid */
import { expect, jest, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode/client"
import type { JSX } from "solid-js"
import { SPINNER_FRAMES } from "../../src/component/spinner"
import { BlockTool, InlineTool } from "../../src/routes/session/index"
import { context } from "../../src/routes/session/render-context"
import { createTimelineAnchors } from "../../src/routes/session/anchors"
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

function part(id: string, state: SessionMessageAssistantTool["state"]): SessionMessageAssistantTool {
  return { type: "tool", id, name: "read", state, time: { created: 0 } }
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
