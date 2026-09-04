import type { OutboxOperation } from './types'

/** Keep the newest mutation for each record; this makes reconnect sync deterministic. */
export function coalesceOutbox(operations: OutboxOperation[]): OutboxOperation[] {
  const latest = new Map<string, OutboxOperation>()
  for (const operation of operations) {
    const key = `${operation.entity}:${operation.entityId}`
    const previous = latest.get(key)
    if (!previous || operation.updatedAt >= previous.updatedAt) latest.set(key, operation)
  }
  return [...latest.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
}
