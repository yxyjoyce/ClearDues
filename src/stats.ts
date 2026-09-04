import type { Debt, LedgerStats, Repayment } from './types'

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

export function remainingCents(debt: Debt, repayments: Repayment[]): number {
  const paid = activeRepayments(repayments)
    .filter((item) => item.debtId === debt.id)
    .reduce((sum, item) => sum + item.amountCents, 0)
  return Math.max(0, debt.initialAmountCents - paid)
}

export function calculateStats(debts: Debt[], repayments: Repayment[], month = new Date()): LedgerStats {
  const activeDebts = debts.filter((item) => !item.deletedAt)
  const active = activeRepayments(repayments)
  const oweBalanceCents = activeDebts
    .filter((item) => item.direction === 'owe')
    .reduce((sum, debt) => sum + remainingCents(debt, active), 0)
  const owedBalanceCents = activeDebts
    .filter((item) => item.direction === 'owed')
    .reduce((sum, debt) => sum + remainingCents(debt, active), 0)
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const monthlyRepaymentCents = active
    .filter((item) => {
      const date = new Date(`${item.date}T00:00:00`)
      return date.getFullYear() === year && date.getMonth() === monthIndex
    })
    .reduce((sum, item) => sum + item.amountCents, 0)
  return { oweBalanceCents, owedBalanceCents, monthlyRepaymentCents, activeDebtCount: activeDebts.length }
}

export function repaymentProgress(debt: Debt, repayments: Repayment[]): number {
  if (debt.initialAmountCents <= 0) return 1
  const remaining = remainingCents(debt, repayments)
  return Math.min(1, Math.max(0, (debt.initialAmountCents - remaining) / debt.initialAmountCents))
}
