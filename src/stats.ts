import type { Debt, LedgerStats, Repayment } from './types'
import { asOfForMonth, calculateDebtBalance, todayLocalDate } from './interest'

export function debtOccurredDate(debt: Debt): string {
  return debt.occurredDate ?? debt.updatedAt.slice(0, 10)
}

export function filterDebtsByMonth(debts: Debt[], month: string): Debt[] {
  return debts.filter((debt) => !debt.deletedAt && debtOccurredDate(debt).startsWith(month))
}

export function filterRepaymentsThroughMonth(repayments: Repayment[], month: string): Repayment[] {
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`
  return repayments.filter((repayment) => !repayment.deletedAt && repayment.date <= monthEnd)
}

export function uniqueDebtPeople(debts: Debt[]): string[] {
  const seen = new Set<string>()
  return [...debts]
    .filter((debt) => !debt.deletedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((debt) => debt.person.trim())
    .filter((person) => {
      const key = person.toLocaleLowerCase()
      if (!person || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function defaultDebtPerson(debts: Debt[]): string {
  return uniqueDebtPeople(debts)[0] ?? ''
}

export function activeRepayments(repayments: Repayment[]): Repayment[] {
  return repayments.filter((item) => !item.deletedAt)
}

export function debtBalance(debt: Debt, repayments: Repayment[], asOf = todayLocalDate()) {
  return calculateDebtBalance(debt, repayments, asOf)
}

export function repaymentBalanceLimit(debt: Debt, repayments: Repayment[], repayment?: Repayment): number {
  const balance = calculateDebtBalance(debt, repayments, repayment?.date ?? todayLocalDate(), repayment ? { excludeRepaymentId: repayment.id, throughRepayment: repayment } : {})
  return balance.totalRemainingCents
}

export function remainingCents(debt: Debt, repayments: Repayment[], asOf = todayLocalDate()): number {
  return calculateDebtBalance(debt, repayments, asOf).totalRemainingCents
}

export function calculateStats(debts: Debt[], repayments: Repayment[], month = new Date(), now = new Date()): LedgerStats {
  const activeDebts = debts.filter((item) => !item.deletedAt)
  const active = activeRepayments(repayments)
  const monthValue = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`
  const asOf = asOfForMonth(monthValue, now)
  const oweBalanceCents = activeDebts
    .filter((item) => item.direction === 'owe')
    .reduce((sum, debt) => sum + remainingCents(debt, active, asOf), 0)
  const owedBalanceCents = activeDebts
    .filter((item) => item.direction === 'owed')
    .reduce((sum, debt) => sum + remainingCents(debt, active, asOf), 0)
  const monthlyRepaymentCents = active
    .filter((item) => {
      return item.date.startsWith(monthValue) && item.date <= asOf
    })
    .reduce((sum, item) => sum + item.amountCents, 0)
  return { oweBalanceCents, owedBalanceCents, monthlyRepaymentCents, activeDebtCount: activeDebts.length }
}

export function repaymentProgress(debt: Debt, repayments: Repayment[]): number {
  if (debt.initialAmountCents <= 0) return 1
  const balance = calculateDebtBalance(debt, repayments)
  const total = debt.initialAmountCents + balance.totalAccruedInterestCents
  return total > 0 ? Math.min(1, Math.max(0, (total - balance.totalRemainingCents) / total)) : 1
}
