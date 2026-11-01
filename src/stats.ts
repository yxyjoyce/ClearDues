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

export interface RepaymentAllocation {
  debtId: string
  amountCents: number
}

export interface RepaymentAllocationPlan {
  allocations: RepaymentAllocation[]
  totalLimitCents: number
  unallocatedCents: number
  amountValid: boolean
  valid: boolean
}

export function areRepaymentBatchDebtsValid(selectedIds: string[], debts: Debt[], userId: string): boolean {
  if (selectedIds.length < 2 || new Set(selectedIds).size !== selectedIds.length) return false
  const selected = selectedIds.map((id) => debts.find((debt) => debt.id === id)).filter((debt): debt is Debt => Boolean(debt))
  if (selected.length !== selectedIds.length) return false
  const first = selected[0]
  const personKey = first.person.trim().toLocaleLowerCase()
  return selected.every((debt) => !debt.deletedAt && debt.userId === userId && debt.direction === first.direction && debt.person.trim().toLocaleLowerCase() === personKey)
}

export function allocateRepaymentAmount(debts: Debt[], repayments: Repayment[], amountCents: number, repaymentDate = todayLocalDate()): RepaymentAllocationPlan {
  const orderedDebts = debts.filter((debt) => !debt.deletedAt).slice().sort((a, b) => debtOccurredDate(a).localeCompare(debtOccurredDate(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const today = todayLocalDate()
  const asOf = repaymentDate > today ? today : repaymentDate
  const balances = orderedDebts.map((debt) => calculateDebtBalance(debt, repayments, asOf).totalRemainingCents)
  const amountValid = Number.isSafeInteger(amountCents) && amountCents > 0
  const totalLimitCents = balances.reduce((sum, balance) => sum + balance, 0)
  let remainingCents = amountValid ? amountCents : 0
  const allocations = orderedDebts.map((debt, index) => {
    const allocated = Math.min(balances[index], remainingCents)
    remainingCents -= allocated
    return { debtId: debt.id, amountCents: allocated }
  })
  const allocatedCents = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0)
  const unallocatedCents = amountValid ? Math.max(0, amountCents - allocatedCents) : 0
  return { allocations, totalLimitCents, unallocatedCents, amountValid, valid: amountValid && unallocatedCents === 0 }
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
