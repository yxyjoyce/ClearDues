export type Direction = 'owe' | 'owed'

export interface Debt {
  id: string
  userId: string
  person: string
  direction: Direction
  initialAmountCents: number
  annualInterestRateBps: number | null
  /** Date the debt happened; optional only while reading legacy local rows. */
  occurredDate?: string
  dueDate: string | null
  notes: string
  deletedAt: string | null
  updatedAt: string
}

export interface Repayment {
  id: string
  userId: string
  debtId: string
  amountCents: number
  date: string
  notes: string
  deletedAt: string | null
  updatedAt: string
}

export type OutboxEntity = 'debt' | 'repayment'
export type OutboxAction = 'upsert' | 'delete'

export interface OutboxOperation {
  id: string
  entity: OutboxEntity
  entityId: string
  action: OutboxAction
  payload: Debt | Repayment
  updatedAt: string
  attempts: number
  lastError?: string
}

export interface LedgerStats {
  oweBalanceCents: number
  owedBalanceCents: number
  monthlyRepaymentCents: number
  activeDebtCount: number
}
