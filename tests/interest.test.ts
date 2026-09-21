import { describe, expect, it } from 'vitest'
import { asOfForMonth, calculateDebtBalance, dateDifferenceInDays, formatAnnualInterestRate, MAX_ANNUAL_INTEREST_RATE_BPS, parseAnnualInterestRateBps, todayLocalDate } from '../src/interest'
import type { Debt, Repayment } from '../src/types'

const debt = (overrides: Partial<Debt> = {}): Debt => ({ id: 'd1', userId: 'u1', person: 'A', direction: 'owe', initialAmountCents: 36500, annualInterestRateBps: 10000, occurredDate: '2026-09-01', dueDate: null, notes: '', deletedAt: null, updatedAt: '2026-09-01T00:00:00.000Z', ...overrides })
const repayment = (overrides: Partial<Repayment> = {}): Repayment => ({ id: 'r1', userId: 'u1', debtId: 'd1', amountCents: 1000, date: '2026-09-02', notes: '', deletedAt: null, updatedAt: '2026-09-02T00:00:00.000Z', ...overrides })

describe('interest calculation', () => {
  it('keeps no-interest balances compatible with principal-only accounting', () => {
    const result = calculateDebtBalance(debt({ annualInterestRateBps: null, initialAmountCents: 10000 }), [repayment({ amountCents: 2500 })], '2026-09-10')
    expect(result).toMatchObject({ principalRemainingCents: 7500, interestRemainingCents: 0, totalRemainingCents: 7500, totalAccruedInterestCents: 0 })
  })

  it('keeps repayments dated before an old debt occurred date in the legacy principal balance', () => {
    const result = calculateDebtBalance(debt({ annualInterestRateBps: null, initialAmountCents: 10000, occurredDate: '2026-09-10' }), [repayment({ amountCents: 2500, date: '2026-09-01' })], '2026-09-10')
    expect(result.totalRemainingCents).toBe(7500)
  })

  it('uses UTC date-only day differences and accrues one day of interest', () => {
    expect(dateDifferenceInDays('2026-09-01', '2026-09-02')).toBe(1)
    expect(calculateDebtBalance(debt({ initialAmountCents: 36500 }), [], '2026-09-02').totalAccruedInterestCents).toBe(100)
  })

  it('calculates segmented interest after an early partial principal payment', () => {
    const result = calculateDebtBalance(debt({ initialAmountCents: 36500 }), [repayment({ amountCents: 18500, date: '2026-09-02' })], '2026-09-03')
    expect(result.principalRemainingCents).toBe(18000)
    expect(result.totalAccruedInterestCents).toBe(149)
    expect(result.interestRemainingCents).toBe(149)
  })

  it('uses payment above principal to reduce accrued interest and stops after principal is zero', () => {
    const result = calculateDebtBalance(debt({ initialAmountCents: 36500 }), [repayment({ amountCents: 36600, date: '2026-09-02' })], '2026-09-10')
    expect(result.principalRemainingCents).toBe(0)
    expect(result.totalAccruedInterestCents).toBe(100)
    expect(result.interestRemainingCents).toBe(0)
  })

  it('ignores future repayments for an earlier as-of date', () => {
    const result = calculateDebtBalance(debt({ annualInterestRateBps: null, initialAmountCents: 10000 }), [repayment({ amountCents: 5000, date: '2026-09-10' })], '2026-09-05')
    expect(result.totalRemainingCents).toBe(10000)
  })

  it('returns no balance before the debt occurred date', () => {
    expect(calculateDebtBalance(debt(), [], '2026-08-31')).toEqual({ principalRemainingCents: 0, accruedInterestCents: 0, interestRemainingCents: 0, totalRemainingCents: 0, totalAccruedInterestCents: 0, paidPrincipalCents: 0, paidInterestCents: 0 })
  })

  it('orders same-day repayments by updatedAt and id', () => {
    const result = calculateDebtBalance(debt({ annualInterestRateBps: null, initialAmountCents: 10000 }), [
      repayment({ id: 'later', amountCents: 7000, updatedAt: '2026-09-02T00:00:02.000Z' }),
      repayment({ id: 'earlier', amountCents: 2000, updatedAt: '2026-09-02T00:00:01.000Z' }),
    ], '2026-09-02', { excludeRepaymentId: 'later', throughRepayment: { id: 'later', date: '2026-09-02', updatedAt: '2026-09-02T00:00:02.000Z' } })
    expect(result.principalRemainingCents).toBe(8000)
  })

  it('rounds at the final currency boundary and clamps negative values', () => {
    const result = calculateDebtBalance(debt({ initialAmountCents: 1, annualInterestRateBps: 1 }), [repayment({ amountCents: 100 })], '2026-09-03')
    expect(result.totalRemainingCents).toBe(0)
    expect(result.paidPrincipalCents).toBe(1)
  })

  it('parses and formats rates with at most two decimals', () => {
    expect(parseAnnualInterestRateBps('5.5')).toBe(550)
    expect(parseAnnualInterestRateBps('0.01')).toBe(1)
    expect(parseAnnualInterestRateBps('5.555')).toBeNull()
    expect(parseAnnualInterestRateBps(String(MAX_ANNUAL_INTEREST_RATE_BPS / 100))).toBe(MAX_ANNUAL_INTEREST_RATE_BPS)
    expect(parseAnnualInterestRateBps('21474836.48')).toBeNull()
    expect(formatAnnualInterestRate(550)).toBe('5.5')
  })

  it('uses local calendar today and month-end as-of dates', () => {
    const now = new Date(2026, 8, 21, 0, 30)
    expect(todayLocalDate(now)).toBe('2026-09-21')
    expect(asOfForMonth('2026-09', now)).toBe('2026-09-21')
    expect(asOfForMonth('2026-08', now)).toBe('2026-08-31')
  })
})
