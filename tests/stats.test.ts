import { describe, expect, it } from 'vitest'
import { calculateDebtBalance, todayLocalDate } from '../src/interest'
import { allocateRepaymentAmount, areRepaymentBatchDebtsValid, calculateStats, debtOccurredDate, defaultDebtPerson, filterDebtsByMonth, filterRepaymentsThroughMonth, repaymentProgress, remainingCents, uniqueDebtPeople } from '../src/stats'
import type { Debt, Repayment } from '../src/types'

const debt = (overrides: Partial<Debt> = {}): Debt => ({ id: 'd1', userId: 'u1', person: 'A', direction: 'owe', initialAmountCents: 10000, annualInterestRateBps: null, occurredDate: '2026-09-01', dueDate: null, notes: '', deletedAt: null, updatedAt: '2026-09-01T00:00:00.000Z', ...overrides })
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

  it('prefers the most recently used existing person and removes duplicate names', () => {
    const recent = debt({ id: 'recent', person: '  李晓  ', updatedAt: '2026-09-04T00:00:00.000Z' })
    const duplicate = debt({ id: 'duplicate', person: '李晓', updatedAt: '2026-09-03T00:00:00.000Z' })
    const older = debt({ id: 'older', person: '周然', updatedAt: '2026-09-02T00:00:00.000Z' })
    expect(uniqueDebtPeople([older, duplicate, recent])).toEqual(['李晓', '周然'])
    expect(defaultDebtPerson([older, duplicate, recent])).toBe('李晓')
    expect(defaultDebtPerson([debt({ deletedAt: '2026-09-04' })])).toBe('')
  })

  it('calculates balances and monthly payments while ignoring soft deletes', () => {
    const result = calculateStats([debt(), debt({ id: 'd2', direction: 'owed', initialAmountCents: 5000, deletedAt: '2026-09-04' })], [payment(), payment({ id: 'r2', amountCents: 1000, deletedAt: '2026-09-04' })], new Date('2026-09-10'))
    expect(result).toMatchObject({ oweBalanceCents: 7500, owedBalanceCents: 0, monthlyRepaymentCents: 2500, activeDebtCount: 1 })
    expect(remainingCents(debt(), [payment()])).toBe(7500)
    expect(repaymentProgress(debt(), [payment()])).toBe(0.25)
  })

  it('includes interest in selected-month statistics without UTC month drift', () => {
    const interestDebt = debt({ initialAmountCents: 36500, annualInterestRateBps: 10000 })
    const result = calculateStats([interestDebt], [], new Date('2026-09-01T00:00:00Z'), new Date(2026, 8, 3, 12))
    expect(result.oweBalanceCents).toBe(36700)
  })

  it('uses principal plus accrued interest as the progress denominator', () => {
    const today = todayLocalDate()
    const prior = new Date()
    prior.setDate(prior.getDate() - 1)
    const occurredDate = todayLocalDate(prior)
    const interestDebt = debt({ initialAmountCents: 36500, annualInterestRateBps: 10000, occurredDate })
    expect(repaymentProgress(interestDebt, [payment({ amountCents: 100, date: today })])).toBe(100 / 36600)
  })

  it('allocates a total from oldest occurred debt forward with integer cents', () => {
    const later = debt({ id: 'd2', occurredDate: '2026-09-02', initialAmountCents: 20000 })
    const earlier = debt({ id: 'd1', occurredDate: '2026-09-01', initialAmountCents: 10000 })
    const plan = allocateRepaymentAmount([later, earlier], [], 15000, '2026-09-03')
    expect(plan.allocations).toEqual([{ debtId: 'd1', amountCents: 10000 }, { debtId: 'd2', amountCents: 5000 }])
    expect(plan).toMatchObject({ totalLimitCents: 30000, unallocatedCents: 0, valid: true })
  })

  it('breaks same-day ties by id and reports zero and over-limit totals', () => {
    const second = debt({ id: 'b', occurredDate: '2026-09-01', initialAmountCents: 10000 })
    const first = debt({ id: 'a', occurredDate: '2026-09-01', initialAmountCents: 10000 })
    expect(allocateRepaymentAmount([second, first], [], 100, '2026-09-03').allocations.slice(0, 1)).toEqual([{ debtId: 'a', amountCents: 100 }])
    expect(allocateRepaymentAmount([first, second], [], 0, '2026-09-03')).toMatchObject({ totalLimitCents: 20000, amountValid: false, valid: false })
    expect(allocateRepaymentAmount([first, second], [], 20001, '2026-09-03')).toMatchObject({ totalLimitCents: 20000, unallocatedCents: 1, valid: false })
  })

  it('rejects missing, deleted, cross-user, or cross-group batch selections while normalizing person names', () => {
    const first = debt({ id: 'first', person: ' 林晓 ' })
    const sameGroup = debt({ id: 'second', person: '林晓' })
    expect(areRepaymentBatchDebtsValid(['first', 'second'], [first, sameGroup], 'u1')).toBe(true)
    expect(areRepaymentBatchDebtsValid(['first', 'missing'], [first, sameGroup], 'u1')).toBe(false)
    expect(areRepaymentBatchDebtsValid(['first', 'second'], [first, { ...sameGroup, deletedAt: '2026-09-04' }], 'u1')).toBe(false)
    expect(areRepaymentBatchDebtsValid(['first', 'second'], [first, { ...sameGroup, userId: 'u2' }], 'u1')).toBe(false)
    expect(areRepaymentBatchDebtsValid(['first', 'second'], [first, { ...sameGroup, direction: 'owed' }], 'u1')).toBe(false)
  })

  it('uses the historical date balance including interest as the per-debt allocation limit', () => {
    const interestDebt = debt({ id: 'interest', occurredDate: '2026-09-01', initialAmountCents: 36500, annualInterestRateBps: 10000 })
    const priorPayment = payment({ id: 'prior', debtId: 'interest', date: '2026-09-02', amountCents: 10000 })
    const expectedLimit = 26673
    const plan = allocateRepaymentAmount([interestDebt], [priorPayment], expectedLimit, '2026-09-03')
    expect(plan.totalLimitCents).toBe(expectedLimit)
    expect(plan.allocations).toEqual([{ debtId: 'interest', amountCents: expectedLimit }])
    expect(remainingCents(interestDebt, [priorPayment], '2026-09-03')).toBe(expectedLimit)
    expect(allocateRepaymentAmount([interestDebt], [priorPayment], expectedLimit + 1, '2026-09-03').valid).toBe(false)
  })

  it('caps future allocation limits at today while preserving accrued interest', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const occurredDate = todayLocalDate(yesterday)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const futureDate = todayLocalDate(tomorrow)
    const interestDebt = debt({ id: 'future-cap', occurredDate, initialAmountCents: 36500, annualInterestRateBps: 10000 })
    const expected = calculateDebtBalance(interestDebt, [], todayLocalDate()).totalRemainingCents
    const plan = allocateRepaymentAmount([interestDebt], [], expected, futureDate)
    expect(plan.totalLimitCents).toBe(expected)
    expect(plan.valid).toBe(true)
    expect(allocateRepaymentAmount([interestDebt], [], expected + 1, futureDate).valid).toBe(false)
  })
})
