import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repayment } from '../src/types'

const mocks = vi.hoisted(() => ({
  repaymentsTable: { bulkPut: vi.fn() },
  outboxTable: { bulkPut: vi.fn() },
  transaction: vi.fn(),
}))

vi.mock('dexie', () => ({
  default: class FakeDexie {
    repayments = mocks.repaymentsTable
    outbox = mocks.outboxTable
    debts = {}
    constructor(_name: string) {}
    version() { return { stores: vi.fn() } }
    transaction(...args: unknown[]) { return mocks.transaction(...args) }
  },
}))

import { ledgerDb, saveRepaymentsOffline } from '../src/db'

const repayment = (id: string): Repayment => ({ id, userId: 'u1', debtId: `d-${id}`, amountCents: 1000, date: '2026-09-03', notes: '', deletedAt: null, updatedAt: '2026-09-03T00:00:00.000Z' })

describe('batch repayment persistence boundary', () => {
  beforeEach(() => {
    ledgerDb.repayments = mocks.repaymentsTable as never
    ledgerDb.outbox = mocks.outboxTable as never
    mocks.repaymentsTable.bulkPut.mockReset().mockResolvedValue(undefined)
    mocks.outboxTable.bulkPut.mockReset().mockResolvedValue(undefined)
    mocks.transaction.mockReset().mockImplementation(async (...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)())
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('outbox-1').mockReturnValueOnce('outbox-2') })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('writes repayments and matching outbox entries through one rw transaction', async () => {
    const records = [repayment('r1'), repayment('r2')]
    await saveRepaymentsOffline(records)

    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.transaction).toHaveBeenCalledWith('rw', ledgerDb.repayments, ledgerDb.outbox, expect.any(Function))
    expect(mocks.repaymentsTable.bulkPut).toHaveBeenCalledWith(records)
    expect(mocks.outboxTable.bulkPut).toHaveBeenCalledWith([
      expect.objectContaining({ entity: 'repayment', entityId: 'r1', payload: records[0] }),
      expect.objectContaining({ entity: 'repayment', entityId: 'r2', payload: records[1] }),
    ])
  })

  it('propagates an outbox failure from inside the transaction callback', async () => {
    mocks.outboxTable.bulkPut.mockRejectedValueOnce(new Error('write failed'))
    await expect(saveRepaymentsOffline([repayment('r1'), repayment('r2')])).rejects.toThrow('write failed')
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.repaymentsTable.bulkPut).toHaveBeenCalledOnce()
    expect(mocks.outboxTable.bulkPut).toHaveBeenCalledOnce()
  })
})
