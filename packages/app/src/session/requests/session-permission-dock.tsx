import { Option, Schema } from "effect"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { PermissionRequest } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Icon } from "@opencode/ui/icon"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { useLanguage } from "@/runtime/i18n/language"
import {
  permissionLabel,
  permissionPhase,
  permissionProgress,
  permissionQueueSummary,
  permissionRemaining,
} from "./permission-dock"

const decodeToolInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

const isString = Schema.is(Schema.String)

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  queued: readonly PermissionRequest[]
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())

  createEffect(
    on(
      () => [props.request.id, props.request.expires, props.request.timeout] as const,
      ([, expires, timeout]) => {
        if (expires === undefined || timeout === undefined || timeout <= 0) return
        setNow(Date.now())
        const interval = setInterval(() => setNow(Date.now()), 250)
        onCleanup(() => clearInterval(interval))
      },
    ),
  )

  const timer = createMemo(() => {
    const { expires, timeout } = props.request
    if (expires === undefined || timeout === undefined || timeout <= 0) return
    const remaining = permissionRemaining(expires, timeout, now())
    return {
      phase: permissionPhase(remaining, timeout),
      label: permissionLabel(remaining),
      progress: permissionProgress(remaining, timeout),
    }
  })

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.action}.description`
    // SAFETY: an action without a curated description returns the key itself, which the check below detects.
    const value = language.t(key as Parameters<typeof language.t>[0])

    if (value === key) return ""

    return value
  }

  const input = () =>
    Option.match(decodeToolInput(props.request.metadata?.input), {
      onNone: () => [],
      onSome: (value) =>
        Object.entries(value).map(([key, item]) => `${key}: ${isString(item) ? item : JSON.stringify(item)}`),
    })

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <Show when={timer()}>
            {(value) => (
              <div data-slot="permission-timer" data-phase={value().phase}>
                <div data-slot="permission-timer-track" aria-hidden="true">
                  <div data-slot="permission-timer-fill" style={{ width: `${value().progress * 100}%` }} />
                </div>
                <span data-slot="permission-timer-label">{value().label}</span>
              </div>
            )}
          </Show>
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="neutral"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="submit" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <Show when={toolDescription()} fallback={<code data-slot="permission-action">{props.request.action}</code>}>
          <div data-slot="permission-hint">{toolDescription()}</div>
        </Show>
      </div>

      <Show when={props.request.message}>
        {(message) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint">{message()}</div>
          </div>
        )}
      </Show>

      <Show when={input().length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          {/* Scrolls rather than truncates: the user approves these arguments, so all of them must be reachable */}
          <div data-slot="permission-input" data-scrollable>
            <For each={input()}>{(line) => <code class="text-text-weak break-all">{line}</code>}</For>
          </div>
        </div>
      </Show>

      <Show when={props.request.resources.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.resources}>
              {(pattern) => <code class="text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={props.queued.length > 0}>
        <div data-slot="permission-queue">
          <div data-slot="permission-queue-title">{language.t("ui.message.queued")}</div>
          <For each={props.queued.slice(0, 3)}>
            {(request) => (
              <div data-slot="permission-queue-row">
                <SessionProgressIndicatorV2 />
                <span data-slot="permission-queue-summary">{permissionQueueSummary(request)}</span>
              </div>
            )}
          </For>
          <Show when={props.queued.length > 3}>
            <div data-slot="permission-queue-more">+{props.queued.length - 3}</div>
          </Show>
        </div>
      </Show>
    </DockPrompt>
  )
}
