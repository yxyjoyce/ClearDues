import { ledgerDb, readLocalLedger } from './db'
import { coalesceOutbox } from './outbox'
import { supabase } from './supabase'
import type { Debt, OutboxOperation, Repayment } from './types'

type TableName = 'debts' | 'repayments'

function tableFor(entity: OutboxOperation['entity']): TableName {
  return entity === 'debt' ? 'debts' : 'repayments'
}

function toRemote(entity: OutboxOperation['entity'], payload: Debt | Repayment) {
  if (entity === 'debt') {
    const debt = payload as Debt
    return { id: debt.id, user_id: debt.userId, person: debt.person, direction: debt.direction, initial_amount_cents: debt.initialAmountCents, due_date: debt.dueDate, notes: debt.notes, deleted_at: debt.deletedAt, updated_at: debt.updatedAt }
  }
  const repayment = payload as Repayment
  return { id: repayment.id, user_id: repayment.userId, debt_id: repayment.debtId, amount_cents: repayment.amountCents, date: repayment.date, notes: repayment.notes, deleted_at: repayment.deletedAt, updated_at: repayment.updatedAt }
}

function fromRemote(entity: OutboxOperation['entity'], row: Record<string, unknown>): Debt | Repayment {
  if (entity === 'debt') return { id: String(row.id), userId: String(row.user_id), person: String(row.person), direction: row.direction as Debt['direction'], initialAmountCents: Number(row.initial_amount_cents), dueDate: row.due_date ? String(row.due_date) : null, notes: String(row.notes ?? ''), deletedAt: row.deleted_at ? String(row.deleted_at) : null, updatedAt: String(row.updated_at) }
  return { id: String(row.id), userId: String(row.user_id), debtId: String(row.debt_id), amountCents: Number(row.amount_cents), date: String(row.date), notes: String(row.notes ?? ''), deletedAt: row.deleted_at ? String(row.deleted_at) : null, updatedAt: String(row.updated_at) }
}

async function clearOutboxRecord(entity: OutboxOperation['entity'], entityId: string): Promise<void> {
  await ledgerDb.outbox.filter((item) => item.entity === entity && item.entityId === entityId).delete()
}

export async function syncLedger(userId: string): Promise<{ synced: boolean; pending: number; error?: string }> {
  if (!supabase) return { synced: false, pending: await ledgerDb.outbox.count(), error: '未配置 Supabase' }
  const pending = coalesceOutbox(await ledgerDb.outbox.toArray()).filter((item) => item.payload.userId === userId)
  for (const operation of pending) {
    const table = tableFor(operation.entity)
    const { data: serverRow, error: readError } = await supabase.from(table).select('*').eq('id', operation.entityId).maybeSingle()
    if (readError) return { synced: false, pending: pending.length, error: readError.message }
    if (serverRow && String(serverRow.updated_at) > operation.updatedAt) {
      const local = fromRemote(operation.entity, serverRow)
      if (operation.entity === 'debt') await ledgerDb.debts.put(local as Debt)
      else await ledgerDb.repayments.put(local as Repayment)
      await clearOutboxRecord(operation.entity, operation.entityId)
      continue
    }
    const { error } = await supabase.from(table).upsert(toRemote(operation.entity, operation.payload) as never, { onConflict: 'id' })
    if (error) return { synced: false, pending: pending.length, error: error.message }
    await clearOutboxRecord(operation.entity, operation.entityId)
  }
  const local = await readLocalLedger(userId)
  const sources: Array<['debt' | 'repayment', Debt[] | Repayment[]]> = [['debt', local.debts], ['repayment', local.repayments]]
  for (const [entity, rows] of sources) {
    const table = entity === 'debt' ? 'debts' : 'repayments'
    const { data, error } = await supabase.from(table).select('*').eq('user_id', userId)
    if (error) return { synced: false, pending: await ledgerDb.outbox.count(), error: error.message }
    for (const row of data ?? []) {
      const remote = fromRemote(entity, row)
      const existing = rows.find((item) => item.id === remote.id)
      if (!existing || remote.updatedAt >= existing.updatedAt) {
        if (entity === 'debt') await ledgerDb.debts.put(remote as Debt)
        else await ledgerDb.repayments.put(remote as Repayment)
      }
    }
  }
  return { synced: true, pending: await ledgerDb.outbox.count() }
}
