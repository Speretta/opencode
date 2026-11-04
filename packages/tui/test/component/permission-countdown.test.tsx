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

function Prompt(props: { timer?: Timer }) {
  return (
    <SessionQuestion
      title="Permission required"
      instance="per_test"
      body={<text>Body</text>}
      options={{ once: "Allow once", reject: "Reject" }}
      timer={props.timer}
      onSelect={() => {}}
    />
  )
}

async function render(timer: Timer | undefined, options: { width: number; height?: number; mode?: "light" | "dark" }) {
  return testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode={options.mode ?? "dark"} source={emptyThemeSource}>
          <Keymap.Provider>
            <Prompt timer={timer} />
          </Keymap.Provider>
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: options.width, height: options.height ?? 14, kittyKeyboard: true },
  )
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
