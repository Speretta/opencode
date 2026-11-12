import { expect, story } from "../../stories/playwright/story"

const now = new Date("2026-10-19T12:00:00Z")

story("shows a countdown and queued permission requests", async ({ mount, page }) => {
  await page.clock.install({ time: now })
  await page.clock.pauseAt(now)
  const component = await mount("session-composer-docks--permission")

  const dock = component.locator('[data-component="dock-prompt"][data-kind="permission"]')
  const timer = dock.locator('[data-slot="permission-timer"]')
  const label = timer.locator('[data-slot="permission-timer-label"]')
  const fill = timer.locator('[data-slot="permission-timer-fill"]')
  const actions = dock.locator('[data-slot="permission-footer-actions"]')
  const queue = dock.locator('[data-slot="permission-queue"]')
  const rows = queue.locator('[data-slot="permission-queue-row"]')

  await expect(timer).toBeVisible()
  await expect(timer).toHaveAttribute("data-phase", "info")
  await expect(label).toHaveText("30s")
  await expect(queue.locator('[data-slot="permission-queue-title"]')).toHaveText("Queued")
  await expect(rows).toHaveCount(3)
  await expect(rows.locator('[data-component="session-progress-indicator-v2"]')).toHaveCount(3)
  await expect(rows.locator('[data-slot="permission-queue-summary"]')).toHaveText([
    "Read packages/app/src/session/requests/model.ts",
    "$ bun test && bun run typecheck",
    "Edit packages/app/src/session/requests/session-permission-dock.tsx",
  ])
  await expect(actions.getByRole("button")).toHaveCount(3)
  await expect(queue.getByRole("button")).toHaveCount(0)
  await expect(component.locator('[data-slot="permission-footer-actions"]')).toHaveCount(1)

  const width = () => fill.evaluate((node) => Number.parseFloat(node.style.width))
  const before = await width()
  await page.clock.runFor(1_000)

  await expect(label).toHaveText("29s")
  expect(await width()).toBeLessThan(before)
})

story("marks queued permission requests beyond the visible rows", async ({ mount, page }) => {
  await page.clock.install({ time: now })
  await page.clock.pauseAt(now)
  const component = await mount("session-composer-docks--permission", { args: { permissionQueued: "4" } })

  const queue = component.locator('[data-component="dock-prompt"][data-kind="permission"] [data-slot="permission-queue"]')
  await expect(queue.locator('[data-slot="permission-queue-row"]')).toHaveCount(3)
  await expect(queue.locator('[data-slot="permission-queue-more"]')).toHaveText("+1")
})
