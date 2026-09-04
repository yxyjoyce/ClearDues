import { describe, expect, it } from 'vitest'
import { coalesceOutbox } from '../src/outbox'
import type { OutboxOperation } from '../src/types'

const op = (id: string, updatedAt: string, action: OutboxOperation['action'] = 'upsert'): OutboxOperation => ({ id, entity: 'debt', entityId: 'same', action, updatedAt, attempts: 0, payload: { id: 'same', userId: 'u1', person: 'A', direction: 'owe', initialAmountCents: 100, dueDate: null, notes: '', deletedAt: action === 'delete' ? updatedAt : null, updatedAt } })

describe('outbox', () => {
  it('keeps the newest mutation for the same entity', () => {
    expect(coalesceOutbox([op('old', '2026-09-01'), op('new', '2026-09-02', 'delete')])).toEqual([op('new', '2026-09-02', 'delete')])
  })
})
