import React from 'react'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateDebtBalance, todayLocalDate } from '../src/interest'
import { formatYuan } from '../src/money'
import type { Debt, Repayment } from '../src/types'

const stylesText = readFileSync('src/styles.css', 'utf8')

const mocks = vi.hoisted(() => ({
  ledger: { debts: [] as Debt[], repayments: [] as Repayment[] },
  demoEnabled: true,
  supabaseConfigured: false,
  supabase: null as null | { auth: Record<string, (...args: unknown[]) => unknown> },
  syncLedger: vi.fn(async () => ({ synced: true, pending: 0 }) as { synced: boolean; pending: number; error?: string }),
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
  get isDemoEnabled() { return mocks.demoEnabled },
  get supabaseConfigured() { return mocks.supabaseConfigured },
  get supabase() { return mocks.supabase },
  signInWithPassword: vi.fn(),
  signUpWithPassword: vi.fn(),
}))

vi.mock('../src/sync', () => ({ syncLedger: mocks.syncLedger }))

import App, { RepaymentChoiceModal } from '../src/App'

const currentDate = todayLocalDate()
const debt = (id: string, overrides: Partial<Debt> = {}): Debt => ({ id, userId: 'demo', person: '林晓', direction: 'owe', initialAmountCents: 10000, annualInterestRateBps: null, occurredDate: currentDate, dueDate: null, notes: '', deletedAt: null, updatedAt: `${currentDate}T00:00:00.000Z`, ...overrides })
const repayment = (id: string, overrides: Partial<Repayment> = {}): Repayment => ({ id, userId: 'demo', debtId: 'd1', amountCents: 2500, date: currentDate, notes: '', deletedAt: null, updatedAt: `${currentDate}T00:00:00.000Z`, ...overrides })
const monthStart = `${currentDate.slice(0, 7)}-01`
const monthSecondDay = `${currentDate.slice(0, 7)}-02`
const shortDate = (value: string) => { const [, month, day] = value.split('-'); return `${Number(month)}月${Number(day)}日` }
const dateInPreviousMonth = (() => { const value = new Date(`${currentDate}T12:00:00`); value.setDate(1); value.setMonth(value.getMonth() - 1); value.setDate(15); return todayLocalDate(value) })()
const dateAfterToday = (() => { const value = new Date(`${currentDate}T12:00:00`); value.setDate(value.getDate() + 1); return todayLocalDate(value) })()

function renderApp(debts: Debt[], repayments: Repayment[] = []) {
  mocks.ledger.debts = debts
  mocks.ledger.repayments = repayments
  return { user: userEvent.setup(), ...render(<App />) }
}

beforeEach(() => {
  mocks.saveDebtOffline.mockReset()
  mocks.saveRepaymentOffline.mockReset()
  mocks.softDeleteOffline.mockReset()
  mocks.supabaseConfigured = false
  mocks.demoEnabled = true
  mocks.supabase = null
  mocks.syncLedger.mockReset().mockResolvedValue({ synced: true, pending: 0 })
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
  it('defaults to all debts and includes historical records', async () => {
    renderApp([
      debt('history', { person: '历史欠款', occurredDate: dateInPreviousMonth, notes: '历史记录' }),
      debt('current', { person: '本月欠款', notes: '本月记录' }),
    ])

    const monthSelect = await screen.findByRole('combobox', { name: '选择月份' })
    expect((monthSelect as HTMLSelectElement).value).toBe('all')
    expect(screen.getByRole('option', { name: '全部欠款' })).toBeTruthy()
    expect(screen.getByText('全部待还')).toBeTruthy()
    expect(screen.getByRole('button', { name: /历史欠款.*历史记录/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /本月欠款.*本月记录/ })).toBeTruthy()
  })

  it('does not count a future repayment in the all-debts balance', async () => {
    renderApp([
      debt('history', { occurredDate: dateInPreviousMonth, initialAmountCents: 10000 }),
    ], [repayment('future', { debtId: 'history', amountCents: 10000, date: dateAfterToday })])

    await screen.findByText('全部待还')
    expect(document.querySelector('.summary-card strong')?.textContent).toBe('¥100.00')
  })

  it('shows only owing principal and interest in the overview summary', async () => {
    const owing = debt('owe', { initialAmountCents: 10000, occurredDate: dateInPreviousMonth, annualInterestRateBps: 10000 })
    const owed = debt('owed', { direction: 'owed', initialAmountCents: 30000, occurredDate: dateInPreviousMonth, annualInterestRateBps: 10000 })
    renderApp([owing, owed])

    await screen.findByText('全部待还')
    const balance = calculateDebtBalance(owing, [], currentDate)
    const summary = document.querySelector('.summary-card') as HTMLElement
    expect(summary.querySelector('strong')?.textContent).toBe(formatYuan(balance.totalRemainingCents))
    expect(summary.querySelector('span')?.textContent).toContain(`本金 ${formatYuan(balance.principalRemainingCents)} · 利息 ${formatYuan(balance.interestRemainingCents)}`)
    expect(summary.querySelector('span')?.textContent).toContain('1 笔欠款')
    expect(summary.querySelector('span')?.textContent).not.toContain('¥300.00')
    expect(summary.querySelector('.summary-icon')).toBeNull()
  })

  it('shows only the selected month after switching away from all debts', async () => {
    const { user } = renderApp([
      debt('history', { person: '历史欠款', occurredDate: dateInPreviousMonth, notes: '历史记录' }),
      debt('current', { person: '本月欠款', notes: '本月记录' }),
    ])

    const monthSelect = await screen.findByRole('combobox', { name: '选择月份' })
    await user.selectOptions(monthSelect, dateInPreviousMonth.slice(0, 7))

    expect((monthSelect as HTMLSelectElement).value).toBe(dateInPreviousMonth.slice(0, 7))
    expect(screen.getByRole('button', { name: /历史欠款.*历史记录/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /本月欠款.*本月记录/ })).toBeNull()
  })

  it('opens the debt editor directly and switches from an existing person to a new person', async () => {
    const { user } = renderApp([debt('d1')])

    await user.click(await screen.findByRole('button', { name: '新增欠款' }))
    expect(screen.getByRole('dialog', { name: '新增欠款' })).toBeTruthy()
    expect((screen.getByRole('combobox', { name: '选择已有欠款人' }) as HTMLSelectElement).value).toBe('林晓')

    await user.click(screen.getByRole('button', { name: '新增欠款人' }))
    const personInput = screen.getByPlaceholderText('例如：林晓')
    await user.type(personInput, '周然')
    await user.type(screen.getByPlaceholderText('0.00'), '10')
    await user.click(screen.getByRole('button', { name: '确认新增欠款' }))

    expect(mocks.saveDebtOffline).toHaveBeenCalledWith(expect.objectContaining({ person: '周然', initialAmountCents: 1000 }))
  })

  it('opens a single overview quick repayment directly and keeps card actions separate', async () => {
    const { user } = renderApp([debt('d1')])
    const card = (await screen.findByText('林晓')).closest('.debt-summary-card') as HTMLElement
    const buttons = Array.from(card.querySelectorAll('button'))
    expect(buttons).toHaveLength(2)
    expect(buttons.every((button) => !button.querySelector('button'))).toBe(true)
    expect(within(card).getByRole('button', { name: '去还款' })).toBeTruthy()

    await user.click(within(card).getByRole('button', { name: '去还款' }))
    expect(screen.getByRole('dialog', { name: '记还款' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '林晓' })).toBeNull()
  })

  it('opens a choice list for multiple overview quick repayments and hides it for settled groups', async () => {
    const { user } = renderApp([
      debt('d1', { notes: '第一笔' }),
      debt('d2', { notes: '第二笔' }),
    ])
    const card = (await screen.findByText('林晓')).closest('.debt-summary-card') as HTMLElement
    await user.click(within(card).getByRole('button', { name: '去还款' }))
    expect(screen.getByRole('dialog', { name: '选择未结清欠款' })).toBeTruthy()

    cleanup()
    renderApp([debt('settled')], [repayment('settled-repayment', { debtId: 'settled', amountCents: 10000 })])
    const settledCard = (await screen.findByText('林晓')).closest('.debt-summary-card') as HTMLElement
    expect(within(settledCard).queryByRole('button', { name: '去还款' })).toBeNull()
  })

  it('returns from detail to its source tab and only shows return for settled groups', async () => {
    const { user } = renderApp([debt('d1')])
    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    expect(screen.getByRole('button', { name: '返回总览' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '记还款' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '返回总览' }))

    await user.click(screen.getByRole('button', { name: '账单' }))
    await user.click(screen.getByRole('button', { name: /查看 林晓 详情/ }))
    expect(screen.getByRole('button', { name: '返回账单' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '返回账单' }))

    cleanup()
    renderApp([debt('settled')], [repayment('settled-repayment', { debtId: 'settled', amountCents: 10000 })])
    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    expect(screen.getByRole('button', { name: '返回总览' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '记还款' })).toBeNull()
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
    await user.click(screen.getByRole('button', { name: '保存欠款' }))

    expect(mocks.saveDebtOffline).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1', initialAmountCents: 12000 }))
  })

  it('keeps detail debt rows to two text lines with amount and actions in one right-side container', async () => {
    const longNote = '这是一条很长的备注，用来确认第二行会省略但完整内容仍可查阅'
    const { user } = renderApp([debt('d1', { notes: longNote, annualInterestRateBps: 325 })])

    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    const detailDialog = screen.getByRole('dialog', { name: '林晓' })
    const row = detailDialog.querySelector('.detail-debt-row') as HTMLElement
    const top = row.querySelector('.detail-row-top') as HTMLElement
    const note = row.querySelector('.detail-row-note') as HTMLButtonElement
    const actions = row.querySelector('.detail-row-actions') as HTMLElement

    expect(top.querySelector('.detail-row-date')?.textContent).toBe(currentDate.replaceAll('-', '.'))
    expect(note.querySelector('small')?.getAttribute('title')).toBe(longNote)
    expect(note.getAttribute('aria-expanded')).toBe('false')
    expect(row.querySelector('.detail-row-amount')?.textContent).toMatch(/^¥100\.\d{2}$/)
    expect(actions.querySelector('[aria-label="编辑欠款 林晓"]')).toBeTruthy()
    expect(actions.querySelector('[aria-label="删除欠款 林晓"]')).toBeTruthy()
    expect(stylesText).toMatch(/\.detail-row-note small\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/)
    expect(stylesText).not.toMatch(/\.detail-row-actions[^}]*grid-row\s*:/)
    expect(stylesText).not.toMatch(/\.detail-debt-row[^}]*grid-row\s*:/)
  })

  it('expands and collapses each debt summary independently', async () => {
    const longNote = '这是一条较长的欠款备注，展开后需要完整显示备注和利息摘要内容'
    const { user } = renderApp([
      debt('d1', { notes: longNote, annualInterestRateBps: 325 }),
      debt('d2', { notes: '另一笔欠款备注', annualInterestRateBps: 500, occurredDate: monthSecondDay }),
    ])

    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    const detailDialog = screen.getByRole('dialog', { name: '林晓' })
    const copies = Array.from(detailDialog.querySelectorAll<HTMLButtonElement>('.detail-row-note'))
    const longSummary = copies.find((copy) => copy.querySelector('small')?.getAttribute('title')?.includes(longNote))!
    const otherSummary = copies.find((copy) => copy !== longSummary)!
    expect(copies).toHaveLength(2)
    expect(longSummary.getAttribute('aria-expanded')).toBe('false')
    expect(otherSummary.getAttribute('aria-expanded')).toBe('false')
    expect(detailDialog.querySelector('.detail-row-interest')).toBeNull()

    await user.click(longSummary)
    expect(longSummary.getAttribute('aria-expanded')).toBe('true')
    expect(longSummary.querySelector('small')?.textContent).toBe(longNote)
    expect(within(detailDialog).getByText(/累计利息/)).toBeTruthy()
    expect(otherSummary.getAttribute('aria-expanded')).toBe('false')

    await user.click(longSummary)
    expect(longSummary.getAttribute('aria-expanded')).toBe('false')
    expect(otherSummary.getAttribute('aria-expanded')).toBe('false')
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
    expect(secondRow.querySelector('.record-topline')).toBeTruthy()
    expect(secondRow.querySelector('.record-amount')?.textContent).toBe('¥200.00')
    expect(secondRow.querySelector('.record-note')?.textContent).toBe('第二笔')
    expect(secondRow.querySelector('.record-chevron')).toBeTruthy()
    await user.click(secondRow)

    const editorDialog = screen.getByRole('dialog', { name: '编辑记录' })
    expect(within(editorDialog).getByDisplayValue('200.00')).toBeTruthy()
    expect(within(editorDialog).getByRole('button', { name: '保存欠款' })).toBeTruthy()
    expect(within(editorDialog).getByRole('button', { name: '删除记录' })).toBeTruthy()
    const amountInput = within(editorDialog).getByDisplayValue('200.00')
    await user.clear(amountInput)
    await user.type(amountInput, '220')
    await user.click(within(editorDialog).getByRole('button', { name: '保存欠款' }))
    expect(mocks.saveDebtOffline).toHaveBeenCalledWith(expect.objectContaining({ id: 'd2', initialAmountCents: 22000 }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑记录' })).toBeNull())

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const updatedDetailsSection = screen.getByRole('heading', { name: '欠款明细' }).closest('section') as HTMLElement
    await user.click(within(updatedDetailsSection).getByRole('button', { name: `编辑欠款 林晓 ${shortDate(monthStart)} ¥220.00 第二笔` }))
    await user.click(within(screen.getByRole('dialog', { name: '编辑记录' })).getByRole('button', { name: '删除记录' }))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledOnce())
    expect(mocks.softDeleteOffline).toHaveBeenCalledWith('debt', 'd2', expect.any(String))
  })

  it('chooses among multiple open debts, starts with a blank numeric amount, and blocks overpayment', async () => {
    const { user } = renderApp([
      debt('d1', { initialAmountCents: 10000, notes: '早餐' }),
      debt('d2', { initialAmountCents: 20000, notes: '酒店' }),
    ], [repayment('r1', { debtId: 'd1', amountCents: 5000 })])

    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    const detailDialog = screen.getByRole('dialog', { name: '林晓' })
    await user.click(within(detailDialog).getByRole('button', { name: '记还款' }))
    const choiceDialog = screen.getByRole('dialog', { name: '选择未结清欠款' })
    expect(within(choiceDialog).getByRole('button', { name: /早餐.*¥50\.00/ })).toBeTruthy()
    await user.click(within(choiceDialog).getByRole('button', { name: /早餐.*¥50\.00/ }))

    expect(screen.getByRole('dialog', { name: '记还款' })).toBeTruthy()
    expect(within(screen.getByRole('dialog', { name: '记还款' })).getByText('林晓')).toBeTruthy()
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('')
    expect(within(screen.getByRole('dialog', { name: '记还款' })).getByText(/本金 ¥50\.00/)).toBeTruthy()

    const amountInput = screen.getByPlaceholderText('0.00')
    await user.type(amountInput, '60')
    await user.click(screen.getByRole('button', { name: '确认还款' }))
    expect(screen.getByText('还款金额不能超过该笔债务的剩余金额。')).toBeTruthy()
    expect(mocks.saveRepaymentOffline).not.toHaveBeenCalled()

    await user.clear(amountInput)
    await user.type(amountInput, '50')
    await user.click(screen.getByRole('button', { name: '确认还款' }))
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
    expect(within(screen.getByRole('dialog', { name: '编辑记录' })).getByText(/本金 ¥100\.00/)).toBeTruthy()
    const amountInput = screen.getByDisplayValue('100.00')
    await user.clear(amountInput)
    await user.type(amountInput, '80')
    await user.click(screen.getByRole('button', { name: '保存还款' }))

    expect(mocks.saveRepaymentOffline).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', debtId: 'd1', amountCents: 8000 }))
  })

  it('shows a settled empty state instead of an empty repayment choice list', async () => {
    const settledDebt = debt('d1')
    const onClose = vi.fn()
    render(<RepaymentChoiceModal group={{ key: 'owe:林晓', person: '林晓', direction: 'owe', debts: [settledDebt], remaining: 0, paid: 10000, total: 10000, progress: 1, interestRemaining: 0, accruedInterest: 0, asOf: currentDate }} repayments={[repayment('r1', { debtId: 'd1', amountCents: 10000 })]} onClose={onClose} onChoose={() => undefined} />)

    expect(screen.getByText('这些欠款已结清，无需再记录还款。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /剩余/ })).toBeNull()
    const user = userEvent.setup()
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
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
      expect(row.querySelector('.record-topline')).toBeTruthy()
      expect(row.querySelector('.record-note')).toBeTruthy()
      expect(row.querySelector('.record-chevron')).toBeTruthy()
    })

    const summaryCard = Array.from(document.querySelectorAll('.debt-summary-card')).find((card) => card.querySelector('h2')?.textContent === '林晓') as HTMLElement
    expect(summaryCard).toBeTruthy()
    expect(summaryCard.querySelector('.dark-kicker')).toBeNull()
    expect(summaryCard.querySelector('.debt-summary-meta')?.textContent).toContain('无到期日')
    expect(summaryCard.querySelector('.group-balance')?.textContent).toBe('¥75.00')
    expect(summaryCard.querySelector('.debt-summary-footer')?.textContent).toContain('已还 ¥25.00')
    expect(summaryCard.querySelector('.compact-progress > span')?.textContent).toBe('25%')
    expect(summaryCard.querySelector('.compact-progress .progress-track div')?.getAttribute('style')).toContain('25%')
    expect(within(summaryCard).getByRole('button', { name: '去还款' })).toBeTruthy()
  })

  it('keeps the reference card typography, progress alignment, and row text colors explicit', () => {
    expect(stylesText).toMatch(/\.debt-summary-card h2\s*\{[^}]*font-weight:\s*800/)
    expect(stylesText).toMatch(/\.details-card h2\s*\{[^}]*font-weight:\s*700/)
    expect(stylesText).toMatch(/\.record-date\s*\{[^}]*color:\s*var\(--ink\)[^}]*font-size:\s*14px/)
    expect(stylesText).toMatch(/--page:\s*#f7f6f1/)
    expect(stylesText).toMatch(/\.detail-modal\s*\{[^}]*height:\s*100svh[^}]*max-height:\s*100svh/)
    expect(stylesText).toMatch(/\.detail-modal \.row-action\s*\{[^}]*border:\s*0/)
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

    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '暗色主题' }))
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true)
    expect(window.localStorage.getItem('cleardues-theme')).toBe('dark')
    await user.click(screen.getByRole('button', { name: '亮色主题' }))
    expect(document.documentElement.classList.contains('theme-dark')).toBe(false)
    expect(window.localStorage.getItem('cleardues-theme')).toBe('light')
  })

  it('filters bill groups while keeping month totals unchanged and opens the selected details', async () => {
    const { user } = renderApp([
      debt('owe', { person: '待还对象', initialAmountCents: 12000 }),
      debt('owed', { person: '待收对象', direction: 'owed', initialAmountCents: 8000 }),
      debt('settled', { person: '结清对象', initialAmountCents: 5000 }),
    ], [repayment('settled-repayment', { debtId: 'settled', amountCents: 5000 })])

    await user.click(await screen.findByRole('button', { name: '账单' }))
    expect(screen.getByRole('heading', { name: '账单' })).toBeTruthy()
    expect(screen.getAllByRole('combobox', { name: '选择月份' })).toHaveLength(1)
    const summary = document.querySelector('.bills-summary') as HTMLElement
    expect(summary.textContent).toContain('¥120.00')
    expect(summary.textContent).toContain('¥80.00')
    expect(summary.textContent).toContain('共 3 个往来 · 3 笔欠款')

    await user.click(screen.getByRole('button', { name: '待收' }))
    expect(screen.getByRole('button', { name: /待收对象/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /待还对象/ })).toBeNull()
    expect(summary.textContent).toContain('¥120.00')
    expect(summary.textContent).toContain('¥80.00')
    await user.click(screen.getByRole('button', { name: /待收对象/ }))
    expect(screen.getByRole('dialog', { name: '待收对象' })).toBeTruthy()
  })

  it('shows separate empty messages for no records and filters without matches', async () => {
    mocks.demoEnabled = false
    mocks.supabaseConfigured = true
    const authListener = { unsubscribe: vi.fn() }
    mocks.supabase = { auth: {
      getSession: async () => ({ data: { session: { user: { id: 'account-1', email: 'account@example.com' } } } }),
      onAuthStateChange: () => ({ data: { subscription: authListener } }),
      getUser: async () => ({ data: { user: { id: 'account-1' } }, error: null }),
      signOut: async () => ({ error: null }),
    } }
    const { user } = renderApp([])
    await user.click(await screen.findByRole('button', { name: '账单' }))
    expect(screen.getByText('暂无账单记录')).toBeTruthy()
    expect(screen.queryByText('没有符合条件的往来')).toBeNull()

    await user.click(screen.getByRole('button', { name: '总览' }))
    mocks.ledger.debts = [debt('d1')]
    cleanup()
    render(<App />)
    await screen.findByText('林晓')
    await user.click(screen.getByRole('button', { name: '账单' }))
    await user.click(screen.getByRole('button', { name: '待收' }))
    expect(screen.getByText('没有符合条件的往来')).toBeTruthy()
  })

  it('disables manual sync without a configured authenticated account', async () => {
    const { user } = renderApp([debt('d1')])
    await screen.findByText('林晓')
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getAllByText('本地演示').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /立即同步/ })).toHaveProperty('disabled', true)
  })

  it('keeps the sync failure message visible after a failed manual sync', async () => {
    mocks.supabaseConfigured = true
    const authListener = { unsubscribe: vi.fn() }
    mocks.supabase = { auth: {
      getSession: async () => ({ data: { session: { user: { id: 'account-1', email: 'long.account@example.com' } } } }),
      onAuthStateChange: () => ({ data: { subscription: authListener } }),
      getUser: async () => ({ data: { user: { id: 'account-1' } }, error: null }),
      signOut: async () => ({ error: null }),
    } }
    mocks.syncLedger.mockRejectedValue(new Error('network'))
    const { user } = renderApp([debt('d1')])
    await user.click(await screen.findByRole('button', { name: '设置' }))
    await screen.findByText('同步失败，请检查网络后重试。')
    const syncButton = screen.getByRole('button', { name: /立即同步/ })
    expect(syncButton).toHaveProperty('disabled', false)
    await user.click(syncButton)
    expect(await screen.findByText('同步失败，请检查网络后重试。')).toBeTruthy()
    expect(document.querySelector('.status-dot')?.className).toContain('error')
  })

  it('keeps the authenticated account after sign out fails', async () => {
    mocks.supabaseConfigured = true
    const authListener = { unsubscribe: vi.fn() }
    mocks.supabase = { auth: {
      getSession: async () => ({ data: { session: { user: { id: 'account-1', email: 'long.account@example.com' } } } }),
      onAuthStateChange: () => ({ data: { subscription: authListener } }),
      getUser: async () => ({ data: { user: { id: 'account-1' } }, error: null }),
      signOut: async () => ({ error: new Error('network') }),
    } }
    const { user } = renderApp([debt('d1')])
    await user.click(await screen.findByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '退出登录' }))
    expect(await screen.findByText('退出登录失败，请稍后重试。')).toBeTruthy()
    expect(screen.getByText('long.account@example.com')).toBeTruthy()
    expect(screen.getByText('已登录')).toBeTruthy()
  })

  it('shows the optional interest fields, saves basis points, and can turn interest off while editing', async () => {
    const { user } = renderApp([debt('d1', { annualInterestRateBps: 325 })])
    await user.click(await screen.findByRole('button', { name: '新增欠款' }))
    const dialog = screen.getByRole('dialog', { name: '新增欠款' })
    const toggle = within(dialog).getByRole('checkbox', { name: /^包含利息/ })
    expect((within(dialog).getByRole('spinbutton', { name: '年利率' }) as HTMLInputElement).value).toBe('3.25')
    const rate = within(dialog).getByRole('spinbutton', { name: '年利率' })
    await user.clear(rate)
    await user.type(rate, '3.25')
    await user.type(within(dialog).getByPlaceholderText('0.00'), '10')
    await user.click(within(dialog).getByRole('button', { name: '确认新增欠款' }))
    expect(mocks.saveDebtOffline).toHaveBeenCalledWith(expect.objectContaining({ annualInterestRateBps: 325 }))

    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    const detail = screen.getByRole('dialog', { name: '林晓' })
    await user.click(within(detail).getAllByRole('button', { name: '编辑欠款 林晓' })[0])
    const editor = screen.getByRole('dialog', { name: '编辑记录' })
    const editToggle = within(editor).getByRole('checkbox', { name: /^包含利息/ })
    expect((editToggle as HTMLInputElement).checked).toBe(true)
    await user.click(editToggle)
    await user.click(within(editor).getByRole('button', { name: '保存欠款' }))
    expect(mocks.saveDebtOffline).toHaveBeenLastCalledWith(expect.objectContaining({ annualInterestRateBps: null }))
  })

  it('shows interest details and limits a repayment by its selected historical date', async () => {
    const prior = new Date()
    prior.setDate(prior.getDate() - 1)
    const priorDate = `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}-${String(prior.getDate()).padStart(2, '0')}`
    const { user } = renderApp([debt('d1', { occurredDate: priorDate, initialAmountCents: 36500, annualInterestRateBps: 10000 })])
    await screen.findByText('全部待还')
    expect(screen.queryByText(/年利率 100%/)).toBeNull()
    expect(screen.getAllByText(/利息/).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '查看详情' }))
    const detail = screen.getByRole('dialog', { name: '林晓' })
    await user.click(within(detail).getByRole('button', { name: '无备注' }))
    expect(within(detail).getByText(/年利率 100%/)).toBeTruthy()
    await user.click(within(detail).getByRole('button', { name: '记还款' }))
    const editor = screen.getByRole('dialog', { name: '记还款' })
    const repaymentDate = editor.querySelector('input[type="date"]') as HTMLInputElement
    await user.clear(repaymentDate)
    await user.type(repaymentDate, priorDate)
    await user.type(within(editor).getByPlaceholderText('0.00'), '365.50')
    await user.click(within(editor).getByRole('button', { name: '确认还款' }))
    expect(within(editor).getByText('还款金额不能超过该笔债务的剩余金额。')).toBeTruthy()
    expect(mocks.saveRepaymentOffline).not.toHaveBeenCalled()
  })

  it('fills the historical-date repayment limit when settling all', async () => {
    const { user } = renderApp(
      [debt('d1', { occurredDate: dateInPreviousMonth, initialAmountCents: 10000 })],
      [repayment('future', { debtId: 'd1', amountCents: 5000, date: currentDate })],
    )
    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    await user.click(within(screen.getByRole('dialog', { name: '林晓' })).getByRole('button', { name: '记还款' }))
    const editor = screen.getByRole('dialog', { name: '记还款' })
    const repaymentDate = editor.querySelector('input[type="date"]') as HTMLInputElement
    await user.clear(repaymentDate)
    await user.type(repaymentDate, dateInPreviousMonth)
    await user.click(within(editor).getByRole('button', { name: '全部还清 100.00 元' }))
    expect((within(editor).getByRole('textbox', { name: '还款金额（元）' }) as HTMLInputElement).value).toBe('100.00')
    await user.click(within(editor).getByRole('button', { name: '确认还款' }))
    expect(mocks.saveRepaymentOffline).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 10000, date: dateInPreviousMonth }))
  })

  it('defaults interest by the selected person, clears it for a new person, and does not overwrite edits', async () => {
    const { user } = renderApp([
      debt('a', { person: '甲', annualInterestRateBps: 325, updatedAt: `${currentDate}T00:00:00.000Z` }),
      debt('b', { person: '乙', annualInterestRateBps: 500, updatedAt: `${currentDate}T00:00:01.000Z` }),
    ])
    await user.click(await screen.findByRole('button', { name: '新增欠款' }))
    const dialog = screen.getByRole('dialog', { name: '新增欠款' })
    expect((within(dialog).getByRole('spinbutton', { name: '年利率' }) as HTMLInputElement).value).toBe('5')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '选择已有欠款人' }), '甲')
    expect((within(dialog).getByRole('spinbutton', { name: '年利率' }) as HTMLInputElement).value).toBe('3.25')
    await user.click(within(dialog).getByRole('button', { name: '新增欠款人' }))
    expect(within(dialog).queryByRole('spinbutton', { name: '年利率' })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新增欠款' })).toBeNull())

    const selectedCard = Array.from(document.querySelectorAll('.debt-summary-card')).find((card) => card.querySelector('h2')?.textContent === '甲') as HTMLElement
    await user.click(within(selectedCard).getByRole('button', { name: '查看详情' }))
    const selectedDetail = screen.getByRole('dialog', { name: '甲' })
    await user.click(within(selectedDetail).getByRole('button', { name: /编辑欠款 甲/ }))
    expect((within(screen.getByRole('dialog', { name: '编辑记录' })).getByRole('spinbutton', { name: '年利率' }) as HTMLInputElement).value).toBe('3.25')
  })

  it('preserves legacy occurrence dates and saves an explicitly changed date', async () => {
    const legacyDate = dateInPreviousMonth
    const { user } = renderApp([debt('legacy', { occurredDate: undefined, updatedAt: `${legacyDate}T23:00:00.000Z` })])
    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    await user.click(within(screen.getByRole('dialog', { name: '林晓' })).getByRole('button', { name: /编辑欠款/ }))
    const editor = screen.getByRole('dialog', { name: '编辑记录' })
    const occurred = editor.querySelector('input[aria-label="发生日期"]') as HTMLInputElement
    expect(occurred.value).toBe(legacyDate)
    await user.click(within(editor).getByRole('button', { name: '保存欠款' }))
    expect(mocks.saveDebtOffline).toHaveBeenLastCalledWith(expect.objectContaining({ occurredDate: legacyDate }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑记录' })).toBeNull())
    const reopenedCard = document.querySelector('.debt-summary-card') as HTMLElement
    await user.click(within(reopenedCard).getByRole('button', { name: '查看详情' }))
    await user.click(within(screen.getByRole('dialog', { name: '林晓' })).getByRole('button', { name: /编辑欠款 林晓/ }))
    const changedEditor = screen.getByRole('dialog', { name: '编辑记录' })
    const changedOccurred = changedEditor.querySelector('input[aria-label="发生日期"]') as HTMLInputElement
    await user.clear(changedOccurred)
    await user.type(changedOccurred, currentDate)
    await user.click(within(changedEditor).getByRole('button', { name: '保存欠款' }))
    expect(mocks.saveDebtOffline).toHaveBeenLastCalledWith(expect.objectContaining({ occurredDate: currentDate }))
  })

  it('keeps the editor open when deletion is cancelled or fails', async () => {
    const { user } = renderApp([debt('d1')])
    await user.click(await screen.findByRole('button', { name: '查看详情' }))
    const detail = screen.getByRole('dialog', { name: '林晓' })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(within(detail).getByRole('button', { name: '删除欠款 林晓' }))
    expect(screen.getByRole('dialog', { name: '林晓' })).toBeTruthy()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.softDeleteOffline.mockRejectedValue(new Error('write failed'))
    await user.click(within(screen.getByRole('dialog', { name: '林晓' })).getByRole('button', { name: '编辑欠款 林晓' }))
    const editor = screen.getByRole('dialog', { name: '编辑记录' })
    await user.click(within(editor).getByRole('button', { name: '删除记录' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '编辑记录' })).toBeTruthy())
  })

  it('delays normal modal unmount and closes immediately with reduced motion', async () => {
    const { user } = renderApp([debt('d1')])
    await user.click(await screen.findByRole('button', { name: '新增欠款' }))
    const dialog = screen.getByRole('dialog', { name: '新增欠款' })
    await user.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('dialog', { name: '新增欠款' })).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新增欠款' })).toBeNull())

    vi.stubGlobal('matchMedia', () => ({ matches: true, media: '', onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }))
    await user.click(screen.getByRole('button', { name: '新增欠款' }))
    await user.click(within(screen.getByRole('dialog', { name: '新增欠款' })).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新增欠款' })).toBeNull())
  })

  it('shows zero interest summaries for owing and owed interest-enabled bill cards', async () => {
    const owingInterestDebt = debt('owe-interest', { person: '应还方', occurredDate: dateInPreviousMonth, annualInterestRateBps: 500 })
    const owingNoInterestDebt = debt('owe-no-interest', { person: '应还方', initialAmountCents: 20000 })
    const { user } = renderApp([
      owingInterestDebt,
      owingNoInterestDebt,
      debt('owed-interest', { person: '应收方', direction: 'owed', annualInterestRateBps: 500 }),
    ])
    await user.click(await screen.findByRole('button', { name: '账单' }))
    const cards = Array.from(document.querySelectorAll('.bill-card')).map((card) => card.textContent ?? '')
    const owingBalance = calculateDebtBalance(owingInterestDebt, [], currentDate)
    const owingCard = cards.find((text) => text.includes('应还方')) ?? ''
    expect(owingCard).toContain(formatYuan(owingBalance.totalRemainingCents + owingNoInterestDebt.initialAmountCents))
    expect(owingCard).toContain(`本金 ${formatYuan(owingBalance.principalRemainingCents + owingNoInterestDebt.initialAmountCents)} · 未付利息 ${formatYuan(owingBalance.interestRemainingCents)}`)
    expect(cards.find((text) => text.includes('应收方'))).toContain('本金 ¥100.00 · 待收利息 ¥0.00')
  })
})
