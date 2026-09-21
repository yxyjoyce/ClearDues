import type { Debt, Repayment } from './types'

export type InterestBalance = {
  principalRemainingCents: number
  accruedInterestCents: number
  interestRemainingCents: number
  totalRemainingCents: number
  totalAccruedInterestCents: number
  paidPrincipalCents: number
  paidInterestCents: number
}

export type InterestCalculationOptions = {
  excludeRepaymentId?: string
  throughRepayment?: Pick<Repayment, 'date' | 'updatedAt' | 'id'>
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
export const MAX_ANNUAL_INTEREST_RATE_BPS = 2147483647

function utcDay(date: string): number {
  const match = DATE_PATTERN.exec(date)
  if (!match) return Number.NaN
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

export function dateDifferenceInDays(startDate: string, endDate: string): number {
  const start = utcDay(startDate)
  const end = utcDay(endDate)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.round((end - start) / 86400000))
}

export function todayLocalDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function monthEndDate(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number)
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) return month
  return `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`
}

export function asOfForMonth(month: string, now = new Date()): string {
  const currentMonth = todayLocalDate(now).slice(0, 7)
  return month === currentMonth ? todayLocalDate(now) : monthEndDate(month)
}

export function parseAnnualInterestRateBps(value: string | number): number | null {
  const text = String(value).trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(bps) && bps > 0 && bps <= MAX_ANNUAL_INTEREST_RATE_BPS ? bps : null
}

export function formatAnnualInterestRate(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return ''
  return (bps / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

export const parseInterestRateBps = parseAnnualInterestRateBps
export const formatInterestRate = formatAnnualInterestRate

function compareRepayments(a: Repayment, b: Repayment): number {
  return a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)
}

function roundCents(value: number): number {
  return Math.max(0, Math.round(value))
}

export function calculateDebtBalance(debt: Debt, repayments: Repayment[], asOf = todayLocalDate(), options: InterestCalculationOptions = {}): InterestBalance {
  const occurredDate = debt.occurredDate ?? debt.updatedAt.slice(0, 10)
  const initialPrincipal = Math.max(0, debt.initialAmountCents)
  if (asOf < occurredDate) return { principalRemainingCents: 0, accruedInterestCents: 0, interestRemainingCents: 0, totalRemainingCents: 0, totalAccruedInterestCents: 0, paidPrincipalCents: 0, paidInterestCents: 0 }
  const rateBps = debt.annualInterestRateBps ?? null
  const through = options.throughRepayment
  const relevant = repayments
    .filter((repayment) => !repayment.deletedAt && repayment.debtId === debt.id && repayment.date <= asOf)
    .filter((repayment) => repayment.id !== options.excludeRepaymentId)
    .filter((repayment) => !through || repayment.date < through.date || (repayment.date === through.date && compareRepayments(repayment, through as Repayment) < 0))
    .sort(compareRepayments)

  let principal = initialPrincipal
  let accruedInterest = 0
  let interestRemaining = 0
  let cursor = occurredDate

  const accrueThrough = (date: string) => {
    const days = dateDifferenceInDays(cursor, date)
    if (days > 0 && principal > 0 && rateBps) {
      const interest = principal * rateBps * days / (365 * 10000)
      accruedInterest += interest
      interestRemaining += interest
    }
    if (date > cursor) cursor = date
  }

  for (const repayment of relevant) {
    accrueThrough(repayment.date < occurredDate ? occurredDate : repayment.date)
    let payment = Math.max(0, repayment.amountCents)
    const principalPayment = Math.min(principal, payment)
    principal -= principalPayment
    payment -= principalPayment
    const interestPayment = Math.min(interestRemaining, payment)
    interestRemaining -= interestPayment
  }
  accrueThrough(asOf)

  const principalRemainingCents = roundCents(principal)
  const totalAccruedInterestCents = roundCents(accruedInterest)
  const interestRemainingCents = roundCents(interestRemaining)
  const paidPrincipalCents = Math.max(0, initialPrincipal - principalRemainingCents)
  const paidInterestCents = Math.max(0, Math.min(totalAccruedInterestCents, totalAccruedInterestCents - interestRemainingCents))
  return {
    principalRemainingCents,
    accruedInterestCents: totalAccruedInterestCents,
    interestRemainingCents,
    totalRemainingCents: principalRemainingCents + interestRemainingCents,
    totalAccruedInterestCents,
    paidPrincipalCents,
    paidInterestCents,
  }
}
