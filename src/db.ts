import Dexie, { type Table } from 'dexie'
import type { Debt, OutboxOperation, Repayment } from './types'

function normalizeDebt(debt: Debt): Debt {
  return { ...debt, occurredDate: debt.occurredDate ?? debt.updatedAt.slice(0, 10), annualInterestRateBps: debt.annualInterestRateBps ?? null }
}

class LedgerDatabase extends Dexie {
  debts!: Table<Debt, string>
  repayments!: Table<Repayment, string>
  outbox!: Table<OutboxOperation, string>

  constructor() {
    super('mobile-ledger')
    this.version(1).stores({
      debts: 'id, userId, direction, dueDate, updatedAt, deletedAt',
      repayments: 'id, userId, debtId, date, updatedAt, deletedAt',
      outbox: 'id, entity, entityId, updatedAt',
    })
  }
}

export const ledgerDb = new LedgerDatabase()

export async function readLocalLedger(userId: string): Promise<{ debts: Debt[]; repayments: Repayment[] }> {
  const [debts, repayments] = await Promise.all([
    ledgerDb.debts.where('userId').equals(userId).toArray().then((rows) => rows.map(normalizeDebt)),
    ledgerDb.repayments.where('userId').equals(userId).toArray(),
  ])
  return { debts, repayments }
}

export async function saveDebtOffline(debt: Debt): Promise<void> {
  await ledgerDb.transaction('rw', ledgerDb.debts, ledgerDb.outbox, async () => {
    await ledgerDb.debts.put(debt)
    await ledgerDb.outbox.put({ id: crypto.randomUUID(), entity: 'debt', entityId: debt.id, action: 'upsert', payload: debt, updatedAt: debt.updatedAt, attempts: 0 })
  })
}

export async function saveRepaymentOffline(repayment: Repayment): Promise<void> {
  await ledgerDb.transaction('rw', ledgerDb.repayments, ledgerDb.outbox, async () => {
    await ledgerDb.repayments.put(repayment)
    await ledgerDb.outbox.put({ id: crypto.randomUUID(), entity: 'repayment', entityId: repayment.id, action: 'upsert', payload: repayment, updatedAt: repayment.updatedAt, attempts: 0 })
  })
}

export async function softDeleteOffline(entity: 'debt' | 'repayment', id: string, updatedAt: string): Promise<void> {
  if (entity === 'debt') {
    await ledgerDb.transaction('rw', ledgerDb.debts, ledgerDb.outbox, async () => {
      const current = await ledgerDb.debts.get(id)
      if (!current) return
      const deleted = { ...current, deletedAt: updatedAt, updatedAt }
      await ledgerDb.debts.put(deleted)
      await ledgerDb.outbox.put({ id: crypto.randomUUID(), entity, entityId: id, action: 'delete', payload: deleted, updatedAt, attempts: 0 })
    })
  } else {
    await ledgerDb.transaction('rw', ledgerDb.repayments, ledgerDb.outbox, async () => {
      const current = await ledgerDb.repayments.get(id)
      if (!current) return
      const deleted = { ...current, deletedAt: updatedAt, updatedAt }
      await ledgerDb.repayments.put(deleted)
      await ledgerDb.outbox.put({ id: crypto.randomUUID(), entity, entityId: id, action: 'delete', payload: deleted, updatedAt, attempts: 0 })
    })
  }
}
