/** @jsxImportSource @opentui/solid */
import { expect, jest, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { SessionQuestion } from "../../src/routes/session/permission"
import { emptyThemeSource } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

type Timer = { timeout: number; expires: number }

let toggle: (() => void) | undefined

function FullscreenPrompt(props: { timer: Timer }) {
  const keymap = Keymap.use()
  toggle = () => keymap.dispatch("permission.prompt.fullscreen")
  return (
    <box height="100%" flexGrow={1}>
      <SessionQuestion
        title="Permission required"
        instance="per_test"
        body={<text>Body</text>}
        options={{ once: "Allow once", reject: "Reject" }}
        timer={props.timer}
        fullscreen
        onSelect={() => {}}
      />
    </box>
  )
}

function Prompt(props: { timer?: Timer; padding?: number }) {
  return (
    <box paddingLeft={props.padding ?? 0} paddingRight={props.padding ?? 0} flexDirection="column">
      <SessionQuestion
        title="Permission required"
        instance="per_test"
        body={<text>Body</text>}
        options={{ once: "Allow once", reject: "Reject" }}
        timer={props.timer}
        fullscreen
        onSelect={() => {}}
      />
    </box>
  )
}

async function render(
  timer: Timer | undefined,
  options: { width: number; height?: number; mode?: "light" | "dark"; padding?: number },
) {
  return testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode={options.mode ?? "dark"} source={emptyThemeSource}>
          <Keymap.Provider>
            <Prompt timer={timer} padding={options.padding} />
          </Keymap.Provider>
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: options.width, height: options.height ?? 14, kittyKeyboard: true },
  )
}

function barLine(frame: string) {
  return frame.split("\n").find((line) => line.includes("█"))
}

test("hides the countdown when the request has no timeout", async () => {
  const app = await render(undefined, { width: 60 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("█")
    expect(app.captureCharFrame()).not.toContain("░")
  } finally {
    app.renderer.destroy()
  }
})

test("ticks every 250ms and stops at zero", async () => {
  jest.useFakeTimers()
  const started = 1_000_000
  const now = jest.spyOn(Date, "now").mockReturnValue(started)
  const app = await render({ timeout: 1_000, expires: started + 1_000 }, { width: 60 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("1s")

    now.mockReturnValue(started + 250)
    jest.advanceTimersByTime(250)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("1s")

    now.mockReturnValue(started + 1_000)
    jest.advanceTimersByTime(750)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("0s")
    const timers = jest.getTimerCount()
    now.mockReturnValue(started + 2_000)
    jest.advanceTimersByTime(1_000)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("0s")
    expect(jest.getTimerCount()).toBe(timers)
  } finally {
    app.renderer.destroy()
    now.mockRestore()
    jest.useRealTimers()
  }
})

test("fits the countdown inside the session route padding at 44 columns", async () => {
  const app = await render({ timeout: 60_000, expires: Date.now() + 60_000 }, { width: 44, padding: 2 })
  try {
    await app.renderOnce()
    const line = barLine(app.captureCharFrame())
    expect(line).toContain("1:00")
    expect(line?.length).toBeLessThanOrEqual(44)
    expect(app.captureCharFrame().split("\n").some((row) => /^[█░]+$/.test(row.trim()))).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("fits the countdown in fullscreen at 100 columns", async () => {
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode="dark" source={emptyThemeSource}>
          <Keymap.Provider>
            <FullscreenPrompt timer={{ timeout: 60_000, expires: Date.now() + 60_000 }} />
          </Keymap.Provider>
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 100, height: 14, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("1:00"))
    expect(toggle).toBeDefined()
    toggle!()
    await app.waitForFrame((frame) => frame.includes("minimize"))
    const line = barLine(app.captureCharFrame())
    expect(line).toContain("1:00")
    expect(line?.length).toBeLessThanOrEqual(100)
  } finally {
    app.renderer.destroy()
  }
})

for (const mode of ["light", "dark"] as const) {
  test(`keeps the countdown fill and label readable in ${mode} mode`, async () => {
    const app = await render({ timeout: 60_000, expires: Date.now() + 30_000 }, { width: 60, mode })
    try {
      await app.renderOnce()
      const spans = app.captureSpans().lines.flatMap((line) => line.spans)
      const filled = spans.find((span) => span.text.includes("█"))
      const empty = spans.find((span) => span.text.includes("░"))
      const label = spans.find((span) => span.text.includes("30s"))
      expect(filled).toBeDefined()
      expect(empty).toBeDefined()
      expect(label).toBeDefined()
      expect(filled!.fg.toInts()).not.toEqual(empty!.fg.toInts())
      expect(filled!.fg.toInts()).toEqual(label!.fg.toInts())
    } finally {
      app.renderer.destroy()
    }
  })
}
