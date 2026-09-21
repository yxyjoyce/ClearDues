import { describe, expect, it } from 'vitest'
import { coalesceOutbox } from '../src/outbox'
import type { Debt, OutboxOperation } from '../src/types'
import { fromRemote, toRemote } from '../src/sync'

const op = (id: string, updatedAt: string, action: OutboxOperation['action'] = 'upsert'): OutboxOperation => ({ id, entity: 'debt', entityId: 'same', action, updatedAt, attempts: 0, payload: { id: 'same', userId: 'u1', person: 'A', direction: 'owe', initialAmountCents: 100, annualInterestRateBps: null, dueDate: null, notes: '', deletedAt: action === 'delete' ? updatedAt : null, updatedAt } })

describe('outbox', () => {
  it('keeps the newest mutation for the same entity', () => {
    expect(coalesceOutbox([op('old', '2026-09-01'), op('new', '2026-09-02', 'delete')])).toEqual([op('new', '2026-09-02', 'delete')])
  })

  it('maps the optional annual interest rate to and from remote rows', () => {
    const payload = op('one', '2026-09-02').payload as Debt
    payload.annualInterestRateBps = 550
    expect(toRemote('debt', payload)).toMatchObject({ annual_interest_rate_bps: 550 })
    expect(fromRemote('debt', { id: 'same', user_id: 'u1', person: 'A', direction: 'owe', initial_amount_cents: 100, annual_interest_rate_bps: 550, occurred_date: '2026-09-01', due_date: null, notes: '', deleted_at: null, updated_at: '2026-09-02T00:00:00.000Z' })).toMatchObject({ annualInterestRateBps: 550 })
  })
})
