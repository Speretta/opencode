import type { PermissionRequest } from "@opencode/client/promise"

export type PermissionTimerPhase = "info" | "warning" | "danger"

export function permissionRemaining(expires: number, timeout: number, now = Date.now()) {
  return Math.max(0, Math.min(timeout, expires - now))
}

export function permissionPhase(remaining: number, timeout: number): PermissionTimerPhase {
  const ratio = timeout <= 0 ? 0 : Math.max(0, Math.min(1, remaining / timeout))
  if (ratio > 0.5) return "info"
  if (ratio > 0.2) return "warning"
  return "danger"
}

export function permissionLabel(remaining: number) {
  const seconds = Math.ceil(Math.max(0, remaining) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

export function permissionProgress(remaining: number, timeout: number) {
  if (timeout <= 0) return 0
  return Math.max(0, Math.min(1, remaining / timeout))
}

export function permissionQueueSummary(request: PermissionRequest) {
  const resource = request.resources[0]
  if (request.action === "shell") return request.resources.length > 0 ? `$ ${request.resources.join(" && ")}` : "$"
  if (request.action === "read") return resource ? `Read ${resource}` : "Read"
  if (request.action === "edit" || request.action === "write" || request.action === "patch") {
    return resource ? `Edit ${resource}` : "Edit"
  }
  if (request.action === "glob") return resource ? `Glob "${resource}"` : "Glob"
  if (request.action === "grep") return resource ? `Grep "${resource}"` : "Grep"
  return resource ? `${request.action} ${resource}` : request.action
}
