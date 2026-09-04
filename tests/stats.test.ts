import { describe, expect, it } from 'vitest'
import { calculateStats, repaymentProgress, remainingCents } from '../src/stats'
import type { Debt, Repayment } from '../src/types'

const debt = (overrides: Partial<Debt> = {}): Debt => ({ id: 'd1', userId: 'u1', person: 'A', direction: 'owe', initialAmountCents: 10000, dueDate: null, notes: '', deletedAt: null, updatedAt: '2026-09-01T00:00:00.000Z', ...overrides })
const payment = (overrides: Partial<Repayment> = {}): Repayment => ({ id: 'r1', userId: 'u1', debtId: 'd1', amountCents: 2500, date: '2026-09-03', notes: '', deletedAt: null, updatedAt: '2026-09-03T00:00:00.000Z', ...overrides })

describe('ledger statistics', () => {
  it('calculates balances and monthly payments while ignoring soft deletes', () => {
    const result = calculateStats([debt(), debt({ id: 'd2', direction: 'owed', initialAmountCents: 5000, deletedAt: '2026-09-04' })], [payment(), payment({ id: 'r2', amountCents: 1000, deletedAt: '2026-09-04' })], new Date('2026-09-10'))
    expect(result).toMatchObject({ oweBalanceCents: 7500, owedBalanceCents: 0, monthlyRepaymentCents: 2500, activeDebtCount: 1 })
    expect(remainingCents(debt(), [payment()])).toBe(7500)
    expect(repaymentProgress(debt(), [payment()])).toBe(0.25)
  })
})
