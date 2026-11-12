/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { OpenCodeEvent } from "@opencode/client"
import { createEffect, type ParentProps } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider as DataProviderBase, useData } from "../../../src/context/data"
import { LocationProvider, useLocation } from "../../../src/context/location"
import { createSessionRows } from "../../../src/routes/session/rows"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const sessionID = "session-permission-rows"

function DataProvider(props: ParentProps) {
  return (
    <ConfigProvider config={createTuiResolvedConfig({ session: { verbosity: "medium" } })}>
      <DataProviderBase directory={process.cwd()}>
        <LocationProvider>
          <SyncLocation />
          {props.children}
        </LocationProvider>
      </DataProviderBase>
    </ConfigProvider>
  )
}

function SyncLocation() {
  const data = useData()
  const location = useLocation()
  createEffect(() => location.set(data.location.default()))
  return null
}

function emitEvent(events: ReturnType<typeof createEventStream>, event: OpenCodeEvent) {
  events.emit({ ...event, location: { directory } })
}

function durable(seq: number) {
  return { aggregateID: sessionID, seq, version: 1 as const }
}

test("promotes active and queued tool rows out of the activity group", async () => {
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  }, events)
  let client!: ReturnType<typeof useClient>
  let rows!: ReturnType<typeof createSessionRows>

  function Probe() {
    client = useClient()
    rows = createSessionRows(() => sessionID)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    while (client.connection.status() !== "connected") await Bun.sleep(10)

    emitEvent(events, {
      id: "evt_step_started",
      created: 1,
      type: "session.step.started",
      durable: durable(1),
      data: {
        started: 1,
        sessionID,
        assistantMessageID: "message-assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    for (const [index, id] of ["call-active", "call-queued-one", "call-queued-two"].entries()) {
      emitEvent(events, {
        id: `evt_tool_started_${index}`,
        created: 2 + index,
        type: "session.tool.input.started",
        durable: durable(2 + index),
        data: { sessionID, assistantMessageID: "message-assistant", id, name: "read" },
      })
    }
    while (!rows.some((row) => row.type === "group")) await Bun.sleep(10)

    emitEvent(events, {
      id: "evt_permission_asked",
      created: 10,
      type: "permission.asked",
      data: {
        id: "per_active",
        sessionID,
        action: "read",
        resources: ["src/active.ts"],
        source: { type: "tool", messageID: "message-assistant", id: "call-active" },
        timeout: 60_000,
        expires: 70_000,
      },
    })
    emitEvent(events, {
      id: "evt_permission_queued",
      created: 11,
      type: "permission.queued",
      data: {
        sessionID,
        requests: [
          {
            id: "per_queued_one",
            sessionID,
            action: "read",
            resources: ["src/one.ts"],
            source: { type: "tool", messageID: "message-assistant", id: "call-queued-one" },
          },
          {
            id: "per_queued_two",
            sessionID,
            action: "read",
            resources: ["src/two.ts"],
            source: { type: "tool", messageID: "message-assistant", id: "call-queued-two" },
          },
        ],
      },
    })

    const pendingIDs = () => {
      const group = rows.find((row) => row.type === "group")
      if (group?.type !== "group" || (group.kind !== "exploration" && group.kind !== "activity")) return []
      return group.pending.map((ref) => ref.partID)
    }
    while (pendingIDs().length !== 3) await Bun.sleep(10)

    expect(pendingIDs()).toEqual(["call-active", "call-queued-one", "call-queued-two"])
  } finally {
    app.renderer.destroy()
  }
})
