import { describe, expect, it } from 'vitest'
import { calculateStats, debtOccurredDate, filterDebtsByMonth, filterRepaymentsThroughMonth, repaymentProgress, remainingCents } from '../src/stats'
import type { Debt, Repayment } from '../src/types'

const debt = (overrides: Partial<Debt> = {}): Debt => ({ id: 'd1', userId: 'u1', person: 'A', direction: 'owe', initialAmountCents: 10000, occurredDate: '2026-09-01', dueDate: null, notes: '', deletedAt: null, updatedAt: '2026-09-01T00:00:00.000Z', ...overrides })
const payment = (overrides: Partial<Repayment> = {}): Repayment => ({ id: 'r1', userId: 'u1', debtId: 'd1', amountCents: 2500, date: '2026-09-03', notes: '', deletedAt: null, updatedAt: '2026-09-03T00:00:00.000Z', ...overrides })

describe('ledger statistics', () => {
  it('uses a stable occurred date and safely falls back for legacy debts', () => {
    expect(debtOccurredDate(debt({ occurredDate: '2026-08-20', updatedAt: '2026-09-04T00:00:00.000Z' }))).toBe('2026-08-20')
    expect(debtOccurredDate(debt({ occurredDate: undefined, updatedAt: '2026-09-04T00:00:00.000Z' }))).toBe('2026-09-04')
    expect(filterDebtsByMonth([debt({ id: 'old', occurredDate: '2026-08-20', updatedAt: '2026-09-04T00:00:00.000Z' }), debt({ id: 'new' })], '2026-08')).toHaveLength(1)
  })

  it('does not let a later repayment reduce a historical month balance', () => {
    const historicalDebt = debt({ occurredDate: '2026-08-20', updatedAt: '2026-09-04T00:00:00.000Z' })
    const beforeMonthEnd = payment({ date: '2026-08-31', amountCents: 2500 })
    const laterRepayment = payment({ id: 'r2', date: '2026-09-01', amountCents: 3000 })
    const augustRepayments = filterRepaymentsThroughMonth([beforeMonthEnd, laterRepayment], '2026-08')
    expect(augustRepayments).toEqual([beforeMonthEnd])
    expect(remainingCents(historicalDebt, augustRepayments)).toBe(7500)
  })

  it('calculates balances and monthly payments while ignoring soft deletes', () => {
    const result = calculateStats([debt(), debt({ id: 'd2', direction: 'owed', initialAmountCents: 5000, deletedAt: '2026-09-04' })], [payment(), payment({ id: 'r2', amountCents: 1000, deletedAt: '2026-09-04' })], new Date('2026-09-10'))
    expect(result).toMatchObject({ oweBalanceCents: 7500, owedBalanceCents: 0, monthlyRepaymentCents: 2500, activeDebtCount: 1 })
    expect(remainingCents(debt(), [payment()])).toBe(7500)
    expect(repaymentProgress(debt(), [payment()])).toBe(0.25)
  })
})
