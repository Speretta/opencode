/** @jsxImportSource @opentui/solid */
import { expect, jest, test } from "bun:test"
import { testRender, useTerminalDimensions } from "@opentui/solid"
import type { PermissionRequest } from "@opencode/client"
import { createEffect, createSignal, Show } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { ThemeProvider } from "../../src/context/theme"
import { PermissionPrompt } from "../../src/routes/session/permission"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createApi, createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"

let setVisible!: (value: boolean) => void
let setRequest!: (value: PermissionRequest) => void
let mountedReady!: () => void
let toggleReady!: () => void
let data!: ReturnType<typeof useData>

function request(timeout = 300_000): PermissionRequest {
  return {
    id: "per_test",
    sessionID: "ses_test",
    action: "read",
    resources: ["src/index.ts"],
    timeout,
    expires: Date.now() + timeout,
  }
}

function Harness(props: { request: PermissionRequest }) {
  const dimensions = useTerminalDimensions()
  const [visible, setVisibleSignal] = createSignal(true)
  const [value, setRequestSignal] = createSignal(props.request)
  const commands = Keymap.useCommands()
  const padding = () => (dimensions().width < 44 ? 1 : 2)
  setVisible = setVisibleSignal
  setRequest = setRequestSignal
  data = useData()
  createEffect(() => {
    if (commands().some((command) => command.id === "permission.prompt.fullscreen")) toggleReady()
  })
  mountedReady()
  return (
    <box height="100%" flexGrow={1} paddingLeft={padding()} paddingRight={padding()}>
      <Show when={visible()}>
        <PermissionPrompt request={value()} />
      </Show>
    </box>
  )
}

async function mount(width: number) {
  data = undefined!
  const ready = new Promise<void>((resolve) => {
    mountedReady = resolve
  })
  const fullscreenReady = new Promise<void>((resolve) => {
    toggleReady = resolve
  })
  const temporary = await tmpdir()
  const events = createEventStream()
  const session = {
    id: "ses_test",
    agent: "build",
    title: "test",
    location: { directory },
    projectID: "project",
    parentID: "ses_parent",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const fetch = createFetch(async (url) => {
    if (url.pathname === "/api/session/ses_test") return json({ data: session })
  }, events)
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <ToastProvider>
                <ClientProvider api={createApi(fetch.fetch)}>
                  <DataProvider directory={directory}>
                    <LocationProvider>
                      <Harness request={request()} />
                    </LocationProvider>
                  </DataProvider>
                </ClientProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 16, kittyKeyboard: true },
  )
  await ready
  return {
    app,
    data,
    fullscreenReady,
    setVisible: (value: boolean) => setVisible(value),
    setRequest: (value: PermissionRequest) => setRequest(value),
    async [Symbol.asyncDispose]() {
      try {
        app.renderer.destroy()
      } finally {
        await temporary[Symbol.asyncDispose]()
      }
    },
  }
}

function bar(expected: number, label = "5:00") {
  return `${"█".repeat(expected)} ${label}`
}

async function withFrozenNow(run: () => Promise<void>) {
  const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000)
  try {
    await run()
  } finally {
    now.mockRestore()
  }
}

function assertCountdown(frame: string, width: number, expected: number) {
  const line = frame.split("\n").find((row) => row.includes("█"))
  expect(line?.trimEnd().endsWith(bar(expected))).toBe(true)
  expect(line?.length ?? 0).toBeLessThanOrEqual(width)
  expect(frame).toContain("Allow once")
  expect(frame).toContain("Reject")
}

test("renders the real prompt countdown and options at 44 columns", async () => {
  await withFrozenNow(async () => {
    await using mounted = await mount(44)
    mounted.app.renderer.start()
    await mounted.app.waitForFrame((frame) => frame.includes("5:00"))
    assertCountdown(mounted.app.captureCharFrame(), 44, 29)
  })
})

test("renders the real prompt countdown and options at 40 columns", async () => {
  await withFrozenNow(async () => {
    await using mounted = await mount(40)
    mounted.app.renderer.start()
    await mounted.app.waitForFrame((frame) => frame.includes("5:00"))
    assertCountdown(mounted.app.captureCharFrame(), 40, 27)
  })
})

test("renders the real prompt countdown and options in fullscreen at 100 columns", async () => {
  await withFrozenNow(async () => {
    await using mounted = await mount(100)
    mounted.app.renderer.start()
    await mounted.app.waitForFrame((frame) => frame.includes("5:00"))
    await mounted.fullscreenReady
    await mounted.app.waitForVisualIdle({ quietFrames: 2 })
    mounted.app.mockInput.pressKey("f", { ctrl: true })
    await mounted.app.waitForFrame((frame) => frame.includes("minimize"))
    assertCountdown(mounted.app.captureCharFrame(), 100, 60)
  })
})

test("stops the countdown interval on unmount", async () => {
  jest.useFakeTimers()
  const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000)
  const mounted = await mount(44)
  try {
    await mounted.app.renderOnce()
    const before = jest.getTimerCount()
    mounted.setVisible(false)
    await mounted.app.renderOnce()
    await Promise.resolve()
    await mounted.app.renderOnce()
    expect(jest.getTimerCount()).toBe(before - 1)
  } finally {
    await mounted[Symbol.asyncDispose]()
    now.mockRestore()
    jest.useRealTimers()
  }
})

test("replaces the countdown tick and label when the request changes", async () => {
  jest.useFakeTimers()
  const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000)
  const mounted = await mount(44)
  try {
    await mounted.app.renderOnce()
    const before = jest.getTimerCount()
    mounted.setRequest(request(240_000))
    await mounted.app.renderOnce()
    await Promise.resolve()
    await mounted.app.renderOnce()
    expect(mounted.app.captureCharFrame()).toContain("4:00")
    expect(jest.getTimerCount()).toBe(before)
  } finally {
    await mounted[Symbol.asyncDispose]()
    now.mockRestore()
    jest.useRealTimers()
  }
})

test("keeps the countdown visible while entering rejection feedback", async () => {
  await withFrozenNow(async () => {
    await using mounted = await mount(44)
    mounted.app.renderer.start()
    await mounted.data.session.sync("ses_test")
    await mounted.app.waitFor(() => Boolean(mounted.data.session.get("ses_test")?.parentID), { maxPasses: 100 })
    mounted.app.mockInput.pressArrow("right")
    await Promise.resolve()
    mounted.app.mockInput.pressEnter()
    await mounted.app.waitForFrame((frame) => frame.includes("Reject permission"))
    const frame = mounted.app.captureCharFrame()
    const line = frame.split("\n").find((row) => row.includes("█"))
    expect(line?.trimEnd().endsWith(bar(29))).toBe(true)
    expect(line?.length ?? 0).toBeLessThanOrEqual(44)
    expect(frame).toContain("Tell OpenCode what to do")
    expect(frame).toContain("enter")
    expect(frame).toContain("esc")
  })
})
