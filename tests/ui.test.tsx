import React from 'react'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Debt, Repayment } from '../src/types'

const stylesText = readFileSync('src/styles.css', 'utf8')

const mocks = vi.hoisted(() => ({
  ledger: { debts: [] as Debt[], repayments: [] as Repayment[] },
  saveDebtOffline: vi.fn(),
  saveRepaymentOffline: vi.fn(),
  softDeleteOffline: vi.fn(),
}))

vi.mock('../src/db', () => ({
  readLocalLedger: vi.fn(async () => ({ debts: mocks.ledger.debts, repayments: mocks.ledger.repayments })),
  saveDebtOffline: mocks.saveDebtOffline,
  saveRepaymentOffline: mocks.saveRepaymentOffline,
  softDeleteOffline: mocks.softDeleteOffline,
}))

vi.mock('../src/supabase', () => ({
  isDemoEnabled: true,
  supabaseConfigured: false,
  supabase: null,
  signInWithPassword: vi.fn(),
  signUpWithPassword: vi.fn(),
}))

vi.mock('../src/sync', () => ({ syncLedger: vi.fn(async () => ({ synced: true, pending: 0 })) }))

import App, { RepaymentChoiceModal } from '../src/App'

const currentDate = new Date().toISOString().slice(0, 10)
const debt = (id: string, overrides: Partial<Debt> = {}): Debt => ({ id, userId: 'demo', person: '林晓', direction: 'owe', initialAmountCents: 10000, occurredDate: currentDate, dueDate: null, notes: '', deletedAt: null, updatedAt: `${currentDate}T00:00:00.000Z`, ...overrides })
const repayment = (id: string, overrides: Partial<Repayment> = {}): Repayment => ({ id, userId: 'demo', debtId: 'd1', amountCents: 2500, date: currentDate, notes: '', deletedAt: null, updatedAt: `${currentDate}T00:00:00.000Z`, ...overrides })
const monthStart = `${currentDate.slice(0, 7)}-01`
const monthSecondDay = `${currentDate.slice(0, 7)}-02`
const shortDate = (value: string) => { const [, month, day] = value.split('-'); return `${Number(month)}月${Number(day)}日` }

function renderApp(debts: Debt[], repayments: Repayment[] = []) {
  mocks.ledger.debts = debts
  mocks.ledger.repayments = repayments
  return { user: userEvent.setup(), ...render(<App />) }
}

beforeEach(() => {
  mocks.saveDebtOffline.mockReset()
  mocks.saveRepaymentOffline.mockReset()
  mocks.softDeleteOffline.mockReset()
  window.localStorage.clear()
  document.documentElement.classList.remove('theme-dark')
  document.documentElement.style.colorScheme = 'light'
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-id') })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ClearDues mobile interactions', () => {
  it('opens the debt editor directly and switches from an existing person to a new person', async () => {
    const { user } = renderApp([debt('d1')])

    await user.click(await screen.findByRole('button', { name: '新增欠款' }))
    expect(screen.getByRole('dialog', { name: '新增欠款' })).toBeTruthy()
    expect((screen.getByRole('combobox', { name: '选择已有欠款人' }) as HTMLSelectElement).value).toBe('林晓')

    await user.click(screen.getByRole('button', { name: '新增欠款人' }))
    const personInput = screen.getByPlaceholderText('例如：林晓')
    await user.type(personInput, '周然')
    await user.type(screen.getByPlaceholderText('0.00'), '10')
    await user.click(screen.getByRole('button', { name: '保存记录' }))

    expect(mocks.saveDebtOffline).toHaveBeenCalledWith(expect.objectContaining({ person: '周然', initialAmountCents: 1000 }))
  })

  it('keeps only one dialog when editing a debt from its detail modal and saves the selected record', async () => {
    const { user } = renderApp([debt('d1', { notes: '旅行垫付' })])

    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const detailDialog = screen.getByRole('dialog', { name: '林晓' })
    await user.click(within(detailDialog).getByRole('button', { name: '编辑欠款 林晓' }))

    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: '编辑记录' })).toBeTruthy()
    const editorDialog = screen.getByRole('dialog', { name: '编辑记录' })
    expect(within(editorDialog).getByRole('button', { name: '删除记录' })).toBeTruthy()
    expect(screen.getByDisplayValue('林晓')).toBeTruthy()
    const amountInput = screen.getByDisplayValue('100.00')
    await user.clear(amountInput)
    await user.type(amountInput, '120')
    await user.click(screen.getByRole('button', { name: '保存记录' }))

    expect(mocks.saveDebtOffline).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1', initialAmountCents: 12000 }))
  })

  it('opens the selected second debt row, keeps its editor actions, and can save or delete it', async () => {
    const { user } = renderApp([
      debt('d1', { occurredDate: monthSecondDay, notes: '第一笔', initialAmountCents: 10000 }),
      debt('d2', { occurredDate: monthStart, notes: '第二笔', initialAmountCents: 20000 }),
    ])

    const detailsSection = (await screen.findByRole('heading', { name: '欠款明细' })).closest('section') as HTMLElement
    expect(within(detailsSection).queryByText('逐笔记录')).toBeNull()
    const rows = within(detailsSection).getAllByRole('button')
    expect(rows).toHaveLength(2)
    expect(detailsSection.querySelectorAll('.record-date')[0]?.textContent).toBe(shortDate(monthSecondDay))
    expect(detailsSection.querySelectorAll('.record-date')[1]?.textContent).toBe(shortDate(monthStart))

    const secondRow = within(detailsSection).getByRole('button', { name: `编辑欠款 林晓 ${shortDate(monthStart)} ¥200.00 第二笔` })
    expect(secondRow).toBe(rows[1])
    expect(secondRow.querySelector('.record-value')).toBeTruthy()
    expect(secondRow.querySelector('.record-amount')?.textContent).toBe('¥200.00')
    expect(secondRow.querySelector('.record-note')?.textContent).toBe('第二笔')
    expect(secondRow.querySelector('.record-chevron')).toBeTruthy()
    await user.click(secondRow)

    const editorDialog = screen.getByRole('dialog', { name: '编辑记录' })
    expect(within(editorDialog).getByDisplayValue('200.00')).toBeTruthy()
    expect(within(editorDialog).getByRole('button', { name: '保存记录' })).toBeTruthy()
    expect(within(editorDialog).getByRole('button', { name: '删除记录' })).toBeTruthy()
    const amountInput = within(editorDialog).getByDisplayValue('200.00')
    await user.clear(amountInput)
    await user.type(amountInput, '220')
    await user.click(within(editorDialog).getByRole('button', { name: '保存记录' }))
    expect(mocks.saveDebtOffline).toHaveBeenCalledWith(expect.objectContaining({ id: 'd2', initialAmountCents: 22000 }))

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(within(detailsSection).getByRole('button', { name: `编辑欠款 林晓 ${shortDate(monthStart)} ¥220.00 第二笔` }))
    await user.click(within(screen.getByRole('dialog', { name: '编辑记录' })).getByRole('button', { name: '删除记录' }))
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(mocks.softDeleteOffline).toHaveBeenCalledWith('debt', 'd2', expect.any(String))
  })

  it('chooses among multiple open debts, starts with a blank numeric amount, and blocks overpayment', async () => {
    const { user } = renderApp([
      debt('d1', { initialAmountCents: 10000, notes: '早餐' }),
      debt('d2', { initialAmountCents: 20000, notes: '酒店' }),
    ], [repayment('r1', { debtId: 'd1', amountCents: 5000 })])

    await user.click(await screen.findByRole('button', { name: '去还款' }))
    const choiceDialog = screen.getByRole('dialog', { name: '选择未结清欠款' })
    expect(within(choiceDialog).getByRole('button', { name: /早餐.*¥50\.00/ })).toBeTruthy()
    await user.click(within(choiceDialog).getByRole('button', { name: /早餐.*¥50\.00/ }))

    expect(screen.getByRole('dialog', { name: '记还款' })).toBeTruthy()
    expect((screen.getByLabelText('对方') as HTMLInputElement).value).toBe('林晓')
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('option', { name: /剩余 ¥50\.00/ })).toBeTruthy()

    const amountInput = screen.getByPlaceholderText('0.00')
    await user.type(amountInput, '60')
    await user.click(screen.getByRole('button', { name: '保存记录' }))
    expect(screen.getByText('还款金额不能超过该笔债务的剩余金额。')).toBeTruthy()
    expect(mocks.saveRepaymentOffline).not.toHaveBeenCalled()

    await user.clear(amountInput)
    await user.type(amountInput, '50')
    await user.click(screen.getByRole('button', { name: '保存记录' }))
    expect(mocks.saveRepaymentOffline).toHaveBeenCalledWith(expect.objectContaining({ debtId: 'd1', amountCents: 5000 }))
  })

  it('lets an existing settled repayment edit against its own restored balance', async () => {
    const settledDebt = debt('d1')
    const existingRepayment = repayment('r1', { debtId: 'd1', amountCents: 10000 })
    const { user } = renderApp([settledDebt], [existingRepayment])

    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    const detailDialog = screen.getByRole('dialog', { name: '林晓' })
    await user.click(within(detailDialog).getByRole('button', { name: /还款.*¥100\.00/ }))

    expect(screen.getByRole('heading', { name: '编辑记录' })).toBeTruthy()
    expect(screen.getByRole('option', { name: /剩余 ¥100\.00/ })).toBeTruthy()
    const amountInput = screen.getByDisplayValue('100.00')
    await user.clear(amountInput)
    await user.type(amountInput, '80')
    await user.click(screen.getByRole('button', { name: '保存记录' }))

    expect(mocks.saveRepaymentOffline).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', debtId: 'd1', amountCents: 8000 }))
  })

  it('shows a settled empty state instead of an empty repayment choice list', async () => {
    const settledDebt = debt('d1')
    const onClose = vi.fn()
    render(<RepaymentChoiceModal group={{ key: 'owe:林晓', person: '林晓', direction: 'owe', debts: [settledDebt], remaining: 0, paid: 10000, total: 10000, progress: 1 }} repayments={[repayment('r1', { debtId: 'd1', amountCents: 10000 })]} onClose={onClose} onChoose={() => undefined} />)

    expect(screen.getByText('这些欠款已结清，无需再记录还款。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /剩余/ })).toBeNull()
    const user = userEvent.setup()
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows people for multi-person records and the actual repayment percentage', async () => {
    const { user } = renderApp([
      debt('d1', { person: '林晓' }),
      debt('d2', { person: '周然' }),
    ], [repayment('r1', { debtId: 'd1', amountCents: 2500 })])

    expect(await screen.findByText('全部往来')).toBeTruthy()
    const detailsSection = screen.getByRole('heading', { name: '欠款明细' }).closest('section') as HTMLElement
    expect(detailsSection).toBeTruthy()
    expect(within(detailsSection).queryByText('逐笔记录')).toBeNull()
    expect(within(detailsSection).getByText('林晓')).toBeTruthy()
    expect(within(detailsSection).getByText('周然')).toBeTruthy()
    const detailRows = within(detailsSection).getAllByRole('button')
    expect(detailRows).toHaveLength(2)
    detailRows.forEach((row) => {
      expect(row.querySelector('.record-date')?.textContent).toMatch(/^\d{1,2}月\d{1,2}日$/)
      expect(row.querySelector('.record-value')).toBeTruthy()
      expect(row.querySelector('.record-note')).toBeTruthy()
      expect(row.querySelector('.record-chevron')).toBeTruthy()
    })

    const summaryCard = Array.from(document.querySelectorAll('.debt-summary-card')).find((card) => card.querySelector('h2')?.textContent === '林晓') as HTMLElement
    expect(summaryCard).toBeTruthy()
    expect(summaryCard.querySelector('.dark-kicker')).toBeNull()
    expect(summaryCard.querySelector('.due-label')).toBeTruthy()
    const progress = summaryCard.querySelector('.debt-progress') as HTMLElement
    const progressMeta = progress.querySelectorAll('.progress-meta > span')
    expect(progressMeta[0]?.textContent).toBe('已还 ¥25.00')
    expect(progressMeta[1]?.textContent).toBe('总额 ¥100.00')
    expect(progress.querySelector('.progress-meta')?.textContent).not.toContain('%')
    expect(progress.querySelector('.progress-label')?.textContent).toBe('还款进度 25%')
    expect(progress.querySelector('.progress-label strong')?.textContent).toBe('25%')
    expect(progress.querySelector('.progress-track div')?.getAttribute('style')).toContain('25%')
  })

  it('keeps the reference card typography, progress alignment, and row text colors explicit', () => {
    expect(stylesText).toMatch(/\.debt-summary-card h2\s*\{[^}]*font-weight:\s*800/)
    expect(stylesText).toMatch(/\.details-card h2\s*\{[^}]*font-weight:\s*700/)
    expect(stylesText).toMatch(/\.progress-label\s*\{[^}]*color:\s*var\(--emphasis\)[^}]*font-size:\s*13px[^}]*text-align:\s*left/)
    expect(stylesText).toMatch(/\.progress-label strong\s*\{[^}]*font-weight:\s*700/)
    expect(stylesText).toMatch(/\.record-date\s*\{[^}]*color:\s*var\(--ink\)[^}]*font-size:\s*14px/)
  })

  it('requires confirmation before deleting a debt and closes the detail after confirmation', async () => {
    const { user } = renderApp([debt('d1')])
    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    const detailDialog = screen.getByRole('dialog', { name: '林晓' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    await user.click(within(detailDialog).getByRole('button', { name: '删除欠款 林晓' }))
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(mocks.softDeleteOffline).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '林晓' })).toBeTruthy()

    confirmSpy.mockReturnValue(true)
    await user.click(within(screen.getByRole('dialog', { name: '林晓' })).getByRole('button', { name: '删除欠款 林晓' }))
    expect(mocks.softDeleteOffline).toHaveBeenCalledWith('debt', 'd1', expect.any(String))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hides the all-people heading and collection note for a single owing person', async () => {
    renderApp([debt('d1')])
    await screen.findByText('林晓')

    expect(screen.queryByText('全部往来')).toBeNull()
    expect(screen.queryByText('待收')).toBeNull()
  })

  it('persists explicit light and dark theme choices', async () => {
    const { user } = renderApp([debt('d1')])
    await screen.findByText('林晓')

    await user.click(screen.getByRole('button', { name: '暗色主题' }))
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true)
    expect(window.localStorage.getItem('cleardues-theme')).toBe('dark')
    await user.click(screen.getByRole('button', { name: '亮色主题' }))
    expect(document.documentElement.classList.contains('theme-dark')).toBe(false)
    expect(window.localStorage.getItem('cleardues-theme')).toBe('light')
  })
})
