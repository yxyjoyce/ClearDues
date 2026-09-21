import { useEffect, useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowRight, CalendarDays, Check, ChevronRight, Cloud, CloudOff, CreditCard, Moon, Pencil, Plus, ReceiptText, Settings, Sun, Trash2, Users, Wallet, X } from 'lucide-react'
import { readLocalLedger, saveDebtOffline, saveRepaymentOffline, softDeleteOffline } from './db'
import { formatCents, formatYuan, parseAmountToCents } from './money'
import { asOfForMonth, calculateDebtBalance, formatAnnualInterestRate, MAX_ANNUAL_INTEREST_RATE_BPS, parseAnnualInterestRateBps, todayLocalDate } from './interest'
import { calculateStats, debtBalance, debtOccurredDate, defaultDebtPerson, filterDebtsByMonth, filterRepaymentsThroughMonth, repaymentBalanceLimit, remainingCents, uniqueDebtPeople } from './stats'
import { isDemoEnabled, signInWithPassword, signUpWithPassword, supabase, supabaseConfigured } from './supabase'
import { syncLedger } from './sync'
import type { Debt, Direction, Repayment } from './types'
import './styles.css'

type Tab = 'overview' | 'bills' | 'settings'
type Theme = 'light' | 'dark'
type Editor = { kind: 'debt' | 'repayment'; item?: Debt | Repayment } | null
type AuthUser = { id: string; email: string | null }
type DebtGroup = { key: string; person: string; direction: Direction; debts: Debt[]; remaining: number; paid: number; total: number; progress: number; interestRemaining: number; accruedInterest: number; asOf: string }

const THEME_KEY = 'cleardues-theme'
const nowIso = () => new Date().toISOString()
const today = () => todayLocalDate()
const recordDate = (debt: Debt) => debtOccurredDate(debt)
const shortRecordDate = (debt: Debt) => { const [, month, day] = recordDate(debt).split('-'); return `${Number(month)}月${Number(day)}日` }
const monthLabel = (value: string) => { const [year, month] = value.split('-'); return `${year}年${Number(month)}月` }
const monthOptions = () => Array.from({ length: 12 }, (_, index) => { const date = new Date(); date.setDate(1); date.setMonth(date.getMonth() - index); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` })
const initialTheme = (): Theme => { try { return window.localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' } }

const demoDebts: Debt[] = [
  { id: 'demo-1', userId: 'demo', person: '林晓', direction: 'owe', initialAmountCents: 180000, annualInterestRateBps: null, occurredDate: today(), dueDate: '2026-09-18', notes: '上次旅行垫付', deletedAt: null, updatedAt: nowIso() },
  { id: 'demo-2', userId: 'demo', person: '周然', direction: 'owed', initialAmountCents: 86000, annualInterestRateBps: null, occurredDate: today(), dueDate: '2026-09-12', notes: '餐费分摊', deletedAt: null, updatedAt: nowIso() },
]

function makeDebt(userId: string, form: { person: string; direction: Direction; amount: string; annualInterestRate: string; hasInterest: boolean; dueDate: string; notes: string }, existing?: Debt): Debt | null {
  const cents = parseAmountToCents(form.amount)
  const annualInterestRateBps = form.hasInterest ? parseAnnualInterestRateBps(form.annualInterestRate) : null
  if (!form.person.trim() || cents === null || cents <= 0 || (form.hasInterest && annualInterestRateBps === null)) return null
  return { id: existing?.id ?? crypto.randomUUID(), userId, person: form.person.trim(), direction: form.direction, initialAmountCents: cents, annualInterestRateBps, occurredDate: existing?.occurredDate ?? today(), dueDate: form.dueDate || null, notes: form.notes.trim(), deletedAt: null, updatedAt: nowIso() }
}

function makeRepayment(userId: string, form: { debtId: string; amount: string; date: string; notes: string }, existing?: Repayment): Repayment | null {
  const cents = parseAmountToCents(form.amount)
  if (!form.debtId || cents === null || cents <= 0 || !form.date) return null
  return { id: existing?.id ?? crypto.randomUUID(), userId, debtId: form.debtId, amountCents: cents, date: form.date, notes: form.notes.trim(), deletedAt: null, updatedAt: nowIso() }
}

function groupDebts(debts: Debt[], repayments: Repayment[], asOf: string): DebtGroup[] {
  const groups = new Map<string, Debt[]>()
  debts.forEach((debt) => { const key = `${debt.direction}:${debt.person.trim().toLocaleLowerCase()}`; groups.set(key, [...(groups.get(key) ?? []), debt]) })
  return [...groups.entries()].map(([key, rows]) => {
    const balances = rows.map((debt) => calculateDebtBalance(debt, repayments, asOf))
    const total = rows.reduce((sum, debt) => sum + debt.initialAmountCents, 0) + balances.reduce((sum, balance) => sum + balance.totalAccruedInterestCents, 0)
    const remaining = balances.reduce((sum, balance) => sum + balance.totalRemainingCents, 0)
    const paid = Math.max(0, total - remaining)
    const accruedInterest = balances.reduce((sum, balance) => sum + balance.totalAccruedInterestCents, 0)
    const interestRemaining = balances.reduce((sum, balance) => sum + balance.interestRemainingCents, 0)
    return { key, person: rows[0].person, direction: rows[0].direction, debts: rows.sort((a, b) => recordDate(b).localeCompare(recordDate(a))), total, remaining, paid, progress: total ? Math.min(1, paid / total) : 1, interestRemaining, accruedInterest, asOf }
  }).sort((a, b) => Number(b.remaining > 0) - Number(a.remaining > 0) || b.remaining - a.remaining)
}

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [selectedMonth, setSelectedMonth] = useState(() => today().slice(0, 7))
  const [debts, setDebts] = useState<Debt[]>(isDemoEnabled ? demoDebts : [])
  const [repayments, setRepayments] = useState<Repayment[]>([])
  const [editor, setEditor] = useState<Editor>(null)
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [repaymentChoices, setRepaymentChoices] = useState<DebtGroup | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState(supabaseConfigured ? '等待同步' : isDemoEnabled ? '本地演示' : '未配置同步')
  const [user, setUser] = useState<AuthUser | null>(null)
  const userId = user?.id ?? (isDemoEnabled ? 'demo' : null)

  useEffect(() => {
    try { window.localStorage.setItem(THEME_KEY, theme) } catch { /* storage is optional */ }
    document.documentElement.classList.toggle('theme-dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151515' : '#ffffff')
  }, [theme])
  const refresh = async () => {
    if (!userId) return
    try { const local = await readLocalLedger(userId); if (local.debts.length || !isDemoEnabled) setDebts(local.debts); if (local.repayments.length || !isDemoEnabled) setRepayments(local.repayments) } catch { setSyncMessage('本地缓存暂不可用') }
  }
  useEffect(() => {
    void refresh()
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setUser(data.session ? { id: data.session.user.id, email: data.session.user.email ?? null } : null))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setUser(session ? { id: session.user.id, email: session.user.email ?? null } : null))
    return () => listener.subscription.unsubscribe()
  }, [userId])
  useEffect(() => { if (supabase && user) void syncNow() }, [user])
  useEffect(() => {
    const handleOnline = () => { if (supabase && user) void syncNow(); else setSyncMessage(supabaseConfigured ? '等待同步' : isDemoEnabled ? '本地演示' : '未配置同步') }
    const handleOffline = () => setSyncMessage('当前离线，修改将暂存本地')
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    if (typeof navigator !== 'undefined' && !navigator.onLine) handleOffline()
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline) }
  }, [user])

  const visibleDebts = useMemo(() => debts.filter((item) => !item.deletedAt), [debts])
  const visibleRepayments = useMemo(() => repayments.filter((item) => !item.deletedAt), [repayments])
  const availableMonths = useMemo(() => [...new Set([...monthOptions(), ...visibleDebts.map((debt) => recordDate(debt).slice(0, 7))])], [visibleDebts])
  const monthDebts = useMemo(() => filterDebtsByMonth(visibleDebts, selectedMonth), [visibleDebts, selectedMonth])
  const periodRepayments = useMemo(() => filterRepaymentsThroughMonth(visibleRepayments, selectedMonth), [visibleRepayments, selectedMonth])
  const stats = useMemo(() => calculateStats(monthDebts, periodRepayments, new Date(`${selectedMonth}-01T00:00:00Z`)), [monthDebts, periodRepayments, selectedMonth])
  const selectedAsOf = useMemo(() => asOfForMonth(selectedMonth), [selectedMonth])
  const groups = useMemo(() => groupDebts(monthDebts, periodRepayments, selectedAsOf), [monthDebts, periodRepayments, selectedAsOf])
  const detailGroup = groups.find((group) => group.key === detailKey) ?? null

  async function syncNow() {
    if (!supabase || !user) { setSyncMessage(supabaseConfigured ? '等待登录' : isDemoEnabled ? '本地演示' : '未配置同步'); return }
    if (typeof navigator !== 'undefined' && !navigator.onLine) { setSyncMessage('当前离线，修改将暂存本地'); return }
    setSyncing(true); setSyncMessage('同步中…')
    try {
      const { data, error } = await supabase.auth.getUser()
      if (error || !data.user) { setSyncMessage(error?.message ? '同步失败，请稍后重试。' : '等待登录'); return }
      const result = await syncLedger(data.user.id)
      setSyncMessage(result.synced ? (result.pending ? `${result.pending} 条待同步` : '已同步') : result.error ?? '同步失败')
      await refresh()
    } catch { setSyncMessage('同步失败，请检查网络后重试。') } finally {
      setSyncing(false)
      if (typeof navigator !== 'undefined' && !navigator.onLine) setSyncMessage('当前离线，修改将暂存本地')
    }
  }
  async function saveEditor(item: Debt | Repayment) {
    if (item.id.startsWith('demo-')) return
    if ('person' in item) { await saveDebtOffline(item); setDebts((current) => [...current.filter((row) => row.id !== item.id), item]) } else { await saveRepaymentOffline(item); setRepayments((current) => [...current.filter((row) => row.id !== item.id), item]) }
    setEditor(null); if (supabase && user) { if (typeof navigator === 'undefined' || navigator.onLine) void syncNow(); else setSyncMessage('当前离线，修改将暂存本地') }
  }
  async function remove(item: Debt | Repayment) {
    if (item.id.startsWith('demo-')) return
    if (typeof window !== 'undefined' && !window.confirm(`确定删除这笔${'person' in item ? '欠款' : '还款'}吗？`)) return
    setDetailKey(null)
    const updatedAt = nowIso(); await softDeleteOffline('person' in item ? 'debt' : 'repayment', item.id, updatedAt)
    if ('person' in item) setDebts((current) => current.map((row) => row.id === item.id ? { ...row, deletedAt: updatedAt, updatedAt } : row)); else setRepayments((current) => current.map((row) => row.id === item.id ? { ...row, deletedAt: updatedAt, updatedAt } : row))
    setEditor(null); if (supabase && user) { if (typeof navigator === 'undefined' || navigator.onLine) void syncNow(); else setSyncMessage('当前离线，修改将暂存本地') }
  }
  function openNew(kind: 'debt' | 'repayment') { setEditor({ kind }) }
  function openRepayment(debt: Debt) { setEditor({ kind: 'repayment', item: { debtId: debt.id } as Repayment }) }
  function openRepaymentGroup(group: DebtGroup) {
    setDetailKey(null)
    const openDebts = group.debts.filter((debt) => calculateDebtBalance(debt, visibleRepayments, group.asOf).totalRemainingCents > 0)
    if (openDebts.length === 1) openRepayment(openDebts[0]); else setRepaymentChoices(group)
  }
  if (!userId) return <LoginGate />

  return <div className={`app-shell theme-${theme}`}>
    <header className="topbar"><div className="brand-lockup"><strong>ClearDues</strong></div><div className="topbar-tools"><label className="month-select"><CalendarDays size={15} /><select aria-label="选择月份" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}>{availableMonths.map((value) => <option key={value} value={value}>{monthLabel(value)}</option>)}</select></label><div className="theme-toggle" role="group" aria-label="选择主题"><button className={theme === 'light' ? 'theme-choice selected' : 'theme-choice'} onClick={() => setTheme('light')} aria-label="亮色主题" aria-pressed={theme === 'light'}><Sun size={19} /></button><button className={theme === 'dark' ? 'theme-choice selected' : 'theme-choice'} onClick={() => setTheme('dark')} aria-label="暗色主题" aria-pressed={theme === 'dark'}><Moon size={19} /></button></div></div></header>
    <main className="page-content">{tab === 'overview' && <Overview groups={groups} debts={monthDebts} stats={stats} month={selectedMonth} repayments={periodRepayments} asOf={selectedAsOf} onEdit={(item) => { setDetailKey(null); setEditor({ kind: 'debt', item }) }} onOpenDetails={setDetailKey} onAddRepayment={openRepaymentGroup} />}{tab === 'bills' && <Bills groups={groups} onOpenDetails={setDetailKey} />}{tab === 'settings' && <SettingsPanel email={user?.email ?? null} syncing={syncing} syncMessage={syncMessage} configured={supabaseConfigured} onSignOut={() => setUser(null)} />}</main>
    <div className="bottom-dock"><div className="bottom-actions"><button className="add-debt-button" onClick={() => openNew('debt')}><Plus size={18} />新增欠款</button></div><nav className="bottom-nav" aria-label="主导航"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><CreditCard size={19} /><span>总览</span></button><button className={tab === 'bills' ? 'active' : ''} onClick={() => setTab('bills')}><ReceiptText size={19} /><span>账单</span></button><button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Settings size={19} /><span>设置</span></button></nav></div>
    {repaymentChoices && <RepaymentChoiceModal group={repaymentChoices} repayments={visibleRepayments} onClose={() => setRepaymentChoices(null)} onChoose={(debt) => { setRepaymentChoices(null); openRepayment(debt) }} />}{editor && <EditorModal editor={editor} userId={userId} debts={visibleDebts} repayments={visibleRepayments} onSave={saveEditor} onDelete={remove} onClose={() => setEditor(null)} />}{detailGroup && <DebtDetailModal group={detailGroup} repayments={periodRepayments} onClose={() => setDetailKey(null)} onEditDebt={(debt) => { setDetailKey(null); setEditor({ kind: 'debt', item: debt }) }} onDeleteDebt={remove} onAddRepayment={openRepaymentGroup} onEditRepayment={(item) => { setDetailKey(null); setEditor({ kind: 'repayment', item }) }} />}
  </div>
}

function Overview({ groups, debts, stats, month, repayments, asOf, onEdit, onOpenDetails, onAddRepayment }: { groups: DebtGroup[]; debts: Debt[]; stats: ReturnType<typeof calculateStats>; month: string; repayments: Repayment[]; asOf: string; onEdit: (debt: Debt) => void; onOpenDetails: (key: string) => void; onAddRepayment: (group: DebtGroup) => void }) {
  const personCount = new Set(groups.map((group) => group.person.trim().toLocaleLowerCase())).size
  return <section className="overview-page"><div className="summary-card"><div className="summary-icon"><Wallet size={36} /></div><div className="summary-copy"><p className="card-kicker">{month === today().slice(0, 7) ? '本月待还' : `${monthLabel(month)}待还`}</p><strong>{formatYuan(stats.oweBalanceCents)}</strong><span>共 {debts.filter((debt) => debt.direction === 'owe').length} 笔欠款</span></div></div>{stats.owedBalanceCents > 0 && <div className="collection-note"><ArrowDownLeft size={17} /><span>待收 <strong>{formatYuan(stats.owedBalanceCents)}</strong></span></div>}{personCount > 1 && <div className="section-heading compact"><div><p className="card-kicker">往来对象</p><h2>全部往来</h2></div><span className="muted">{personCount} 人</span></div>}{groups.length ? <div className="group-list">{groups.map((group) => <DebtSummaryCard key={group.key} group={group} onOpenDetails={() => onOpenDetails(group.key)} onAddRepayment={onAddRepayment} />)}</div> : <EmptyState title="还没有欠款记录" description="从下方新增欠款开始，让每笔往来都有迹可循。" />}{groups.length > 0 && <DebtDetailsCard groups={groups} repayments={repayments} asOf={asOf} onEdit={onEdit} />}</section>
}

function DebtSummaryCard({ group, onOpenDetails, onAddRepayment }: { group: DebtGroup; onOpenDetails: () => void; onAddRepayment: (group: DebtGroup) => void }) {
  const dueDates = group.debts.map((debt) => debt.dueDate).filter(Boolean) as string[]; const dueDate = dueDates.length ? dueDates.sort()[0].replaceAll('-', '.') : '无到期日'
  return <article className="debt-summary-card"><div className="debt-summary-head"><h2>{group.person}</h2><span className="due-label">{dueDate}</span></div><div className="debt-balance-row"><div><span className="balance-label">剩余</span><strong>{formatYuan(group.remaining)}</strong>{group.interestRemaining > 0 && <small className="interest-hint">含未付利息 {formatYuan(group.interestRemaining)}</small>}</div>{group.remaining > 0 && <button className="repay-button" onClick={() => onAddRepayment(group)}>{group.direction === 'owe' ? '去还款' : '去收款'} <ArrowRight size={15} /></button>}</div><div className="debt-progress"><div className="progress-meta"><span>{group.direction === 'owe' ? '已还' : '已收'} {formatYuan(group.paid)}</span><span>总额 {formatYuan(group.total)}</span></div><div className="progress-track"><div style={{ width: `${group.progress * 100}%` }} /></div><span className="progress-label">{group.direction === 'owe' ? '还款进度' : '收款进度'} <strong>{Math.round(group.progress * 100)}%</strong></span></div><button className="detail-link" onClick={onOpenDetails}>查看详情 <ChevronRight size={15} /></button></article>
}

function DebtDetailsCard({ groups, repayments, asOf, onEdit }: { groups: DebtGroup[]; repayments: Repayment[]; asOf: string; onEdit: (debt: Debt) => void }) {
  const records = groups.flatMap((group) => group.debts.map((debt) => ({ debt, person: group.person }))).sort((a, b) => recordDate(b.debt).localeCompare(recordDate(a.debt)))
  const showPerson = new Set(records.map(({ person }) => person.trim().toLocaleLowerCase())).size > 1
  return <section className="details-card"><div className="details-card-head"><h2>欠款明细</h2></div><div className="debt-record-list">{records.map(({ debt, person }) => { const balance = calculateDebtBalance(debt, repayments, asOf); return <button type="button" className="debt-record" key={debt.id} onClick={() => onEdit(debt)} aria-label={`编辑欠款 ${person} ${shortRecordDate(debt)} ${formatYuan(balance.totalRemainingCents)} ${debt.notes || '无备注'}`}><span className="record-dot" aria-hidden="true" /><span className="record-copy"><span className="record-date">{shortRecordDate(debt)}</span>{showPerson && <strong className="record-person">{person}</strong>}</span><span className="record-value"><strong className="record-amount">{formatYuan(balance.totalRemainingCents)}</strong><small className="record-note">{debt.notes || '无备注'}</small>{debt.annualInterestRateBps != null && <small className="record-interest">本金 {formatYuan(balance.principalRemainingCents)} · 利息 {formatYuan(balance.interestRemainingCents)} · 年利率 {formatAnnualInterestRate(debt.annualInterestRateBps)}%</small>}</span><ChevronRight className="record-chevron" size={18} aria-hidden="true" /></button> })}</div></section>
}

function Bills({ groups, onOpenDetails }: { groups: DebtGroup[]; onOpenDetails: (key: string) => void }) {
  return <section className="secondary-page compact-record-page">{groups.length ? <div className="account-list">{groups.map((group) => <button className="account-row" key={group.key} onClick={() => onOpenDetails(group.key)}><span className="account-avatar">{group.person.slice(0, 1)}</span><span className="account-info"><strong>{group.person}</strong><small>{group.debts.length} 笔 · {group.direction === 'owe' ? '我欠对方' : '对方欠我'}</small></span><strong className="account-amount">{formatYuan(group.remaining)}</strong><ChevronRight size={17} /></button>)}</div> : <EmptyState title="暂无欠款记录" description="从下方新增欠款开始记录第一笔往来。" />}</section>
}

export function RepaymentChoiceModal({ group, repayments, onClose, onChoose }: { group: DebtGroup; repayments: Repayment[]; onClose: () => void; onChoose: (debt: Debt) => void }) {
  const openDebts = group.debts.filter((debt) => calculateDebtBalance(debt, repayments, group.asOf).totalRemainingCents > 0)
  return <div className="scrim" role="presentation"><div className="modal-card choice-modal" role="dialog" aria-modal="true" aria-labelledby="choice-title"><div className="sheet-title"><div><p className="card-kicker">{group.direction === 'owe' ? '去还款' : '去收款'}</p><h2 id="choice-title">选择未结清欠款</h2></div><button onClick={onClose} aria-label="关闭"><X size={20} /></button></div>{openDebts.length ? <><p className="helper-text">请选择要记录的具体一笔欠款。</p><div className="choice-list">{openDebts.map((debt) => <button className="choice-row" key={debt.id} onClick={() => onChoose(debt)}><span><strong>{recordDate(debt).replaceAll('-', '.')}</strong><small>{debt.notes || '无备注'}</small></span><strong>{formatYuan(calculateDebtBalance(debt, repayments, group.asOf).totalRemainingCents)}</strong></button>)}</div></> : <div className="choice-empty" role="status"><p>这些欠款已结清，无需再记录{group.direction === 'owe' ? '还款' : '收款'}。</p><button className="outline-button" type="button" onClick={onClose}>关闭</button></div>}</div></div>
}

function DebtDetailModal({ group, repayments, onClose, onEditDebt, onDeleteDebt, onAddRepayment, onEditRepayment }: { group: DebtGroup; repayments: Repayment[]; onClose: () => void; onEditDebt: (debt: Debt) => void; onDeleteDebt: (item: Debt) => Promise<void>; onAddRepayment: (group: DebtGroup) => void; onEditRepayment: (repayment: Repayment) => void }) {
  const records = group.debts.flatMap((debt) => repayments.filter((item) => item.debtId === debt.id)).sort((a, b) => b.date.localeCompare(a.date))
  return <div className="scrim" role="presentation"><div className="modal-card detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div className="sheet-title"><div><p className="card-kicker">往来详情</p><h2 id="detail-title">{group.person}</h2></div><button onClick={onClose} aria-label="关闭"><X size={20} /></button></div><div className="detail-balance"><span>{group.direction === 'owe' ? '还需支付' : '还需收回'}</span><strong>{formatYuan(group.remaining)}</strong>{group.interestRemaining > 0 && <small className="interest-hint">含未付利息 {formatYuan(group.interestRemaining)}</small>}<div className="progress-track"><div style={{ width: `${group.progress * 100}%` }} /></div><span className="detail-progress-label">{group.direction === 'owe' ? '已还' : '已收'} {Math.round(group.progress * 100)}%</span></div><div className="detail-records"><div className="detail-section-title"><h3>欠款明细</h3></div>{group.debts.map((debt) => { const balance = debtBalance(debt, repayments, group.asOf); return <div className="detail-debt-row" key={debt.id}><div><strong>{recordDate(debt).replaceAll('-', '.')}</strong><small>{debt.notes || '无备注'}</small>{debt.annualInterestRateBps != null && <small>本金 {formatYuan(balance.principalRemainingCents)} · 累计利息 {formatYuan(balance.totalAccruedInterestCents)} · 未付利息 {formatYuan(balance.interestRemainingCents)} · 年利率 {formatAnnualInterestRate(debt.annualInterestRateBps)}%</small>}</div><strong>{formatYuan(balance.totalRemainingCents)}</strong><div className="detail-row-actions"><button className="row-action" onClick={() => onEditDebt(debt)} aria-label={`编辑欠款 ${group.person}`}><Pencil size={16} /></button><button className="row-action danger" onClick={() => void onDeleteDebt(debt)} aria-label={`删除欠款 ${group.person}`}><Trash2 size={16} /></button></div></div> })}</div><div className="detail-records repayment-records"><div className="detail-section-title"><h3>{group.direction === 'owe' ? '还款流水' : '收款流水'}</h3>{group.remaining > 0 && <button onClick={() => onAddRepayment(group)}><Plus size={14} />{group.direction === 'owe' ? '记还款' : '记收款'}</button>}</div>{records.length ? records.map((item) => <button className="repayment-row" key={item.id} onClick={() => onEditRepayment(item)}><span>{item.date.replaceAll('-', '.')}</span><span>{item.notes || (group.direction === 'owe' ? '还款' : '收款')}</span><strong>{formatYuan(item.amountCents)}</strong><ChevronRight size={15} /></button>) : <p className="detail-empty">还没有流水记录。</p>}</div></div></div>
}

function LoginGate() {
  const [mode, setMode] = useState<'login' | 'signup'>('login'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState(''); const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null); const [submitting, setSubmitting] = useState(false); const isSignup = mode === 'signup'
  function switchMode(nextMode: 'login' | 'signup') { setMode(nextMode); setMessage(null); setConfirmPassword('') }
  async function submit(event: React.FormEvent) { event.preventDefault(); setMessage(null); const cleanEmail = email.trim(); if (isSignup && password !== confirmPassword) { setMessage({ kind: 'error', text: '两次输入的密码不一致。' }); return }; setSubmitting(true); let result; try { result = isSignup ? await signUpWithPassword(cleanEmail, password) : await signInWithPassword(cleanEmail, password) } catch { setSubmitting(false); setMessage({ kind: 'error', text: '当前无法连接认证服务，请检查网络后重试。' }); return }; setSubmitting(false); if (result.error) { setMessage({ kind: 'error', text: result.error }); return }; setMessage({ kind: 'success', text: isSignup && result.needsEmailConfirmation ? '注册成功。请打开确认邮件完成邮箱验证，然后返回这里登录；应用不会发送登录链接。' : isSignup ? '注册成功，正在进入账本…' : '登录成功，正在进入账本…' }) }
  return <main className="auth-gate"><div className="auth-card"><div className="auth-intro"><div className="auth-brand"><span>ClearDues</span></div><p className="eyebrow">个人欠款账本</p><h1>把每笔往来记清楚</h1><p>记录欠款、还款和到期日，让账目清楚，心里轻松。</p></div>{supabaseConfigured ? <><div className="auth-mode" role="tablist" aria-label="认证方式"><button type="button" role="tab" aria-selected={!isSignup} className={!isSignup ? 'selected' : ''} onClick={() => switchMode('login')}>登录</button><button type="button" role="tab" aria-selected={isSignup} className={isSignup ? 'selected' : ''} onClick={() => switchMode('signup')}>注册</button></div><form className="auth-form" onSubmit={submit}><label htmlFor="auth-email">邮箱地址<input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" required /></label><label htmlFor="auth-password">密码<input id="auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 6 位字符" autoComplete={isSignup ? 'new-password' : 'current-password'} minLength={6} required /></label>{isSignup && <label htmlFor="auth-confirm-password">确认密码<input id="auth-confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入密码" autoComplete="new-password" minLength={6} required /></label>}<button className="primary-button full auth-submit" type="submit" disabled={submitting}>{submitting ? '处理中…' : isSignup ? '创建账号' : '登录账本'}</button>{message && <p className={`${message.kind === 'error' ? 'error-message' : 'form-message'} auth-message`} role="status">{message.text}</p>}</form><p className="auth-note">邮箱+密码登录 · 数据仅同步到你的 Supabase 账号</p></> : <div className="notice-card"><CloudOff size={18} /><div><strong>同步尚未配置</strong><p>请复制 .env.example 为 .env.local，填入 Supabase URL 和 Publishable Key。未配置时不会显示或写入账目。</p></div></div>}</div></main>
}

function SettingsPanel({ email, syncing, syncMessage, configured, onSignOut }: { email: string | null; syncing: boolean; syncMessage: string; configured: boolean; onSignOut: () => void }) {
  const syncState = syncing ? 'busy' : syncMessage.includes('失败') ? 'error' : syncMessage.includes('离线') ? 'offline' : configured && syncMessage === '已同步' ? 'on' : ''
  return <section className="secondary-page"><div className="page-heading"><p className="card-kicker">偏好与账户</p><h2>设置</h2><p>管理同步状态和你的使用方式。</p></div><div className="settings-card"><div className="setting-row"><span className="setting-icon"><Cloud size={19} /></span><span><strong>跨设备同步</strong><small>{configured ? syncMessage : '未配置 Supabase'}</small></span><span className={`status-dot ${syncState}`} /></div><div className="setting-row"><span className="setting-icon"><CreditCard size={19} /></span><span><strong>金额单位</strong><small>人民币（元）· 数据按分存储</small></span><span className="muted">CNY</span></div></div><div className="login-card"><h3>已登录</h3><p>{email ?? '当前账号'}</p><button className="outline-button" onClick={() => { void supabase?.auth.signOut(); onSignOut() }}>退出登录</button></div></section>
}

function EditorModal({ editor, userId, debts, repayments, onSave, onDelete, onClose }: { editor: Exclude<Editor, null>; userId: string; debts: Debt[]; repayments: Repayment[]; onSave: (item: Debt | Repayment) => Promise<void>; onDelete: (item: Debt | Repayment) => Promise<void>; onClose: () => void }) {
  const debt = editor.kind === 'debt' ? editor.item as Debt | undefined : undefined
  const repayment = editor.kind === 'repayment' ? editor.item as Repayment | undefined : undefined
  const existingPeople = uniqueDebtPeople(debts)
  const [person, setPerson] = useState(debt?.person ?? (editor.kind === 'debt' ? defaultDebtPerson(debts) : ''))
  const [personMode, setPersonMode] = useState<'existing' | 'new'>(debt || !existingPeople.length ? 'new' : 'existing')
  const [direction, setDirection] = useState<Direction>(debt?.direction ?? 'owe')
  const [amount, setAmount] = useState(debt ? formatCents(debt.initialAmountCents) : repayment && Number.isFinite(repayment.amountCents) ? formatCents(repayment.amountCents) : '')
  const [hasInterest, setHasInterest] = useState(Boolean(debt?.annualInterestRateBps))
  const [annualInterestRate, setAnnualInterestRate] = useState(formatAnnualInterestRate(debt?.annualInterestRateBps))
  const [dueDate, setDueDate] = useState(debt?.dueDate ?? '')
  const [hasDueDate, setHasDueDate] = useState(Boolean(debt?.dueDate))
  const [date, setDate] = useState(repayment?.date ?? today())
  const [debtId, setDebtId] = useState(repayment?.debtId ?? debts.find((item) => remainingCents(item, repayments) > 0)?.id ?? '')
  const [notes, setNotes] = useState(debt?.notes ?? repayment?.notes ?? '')
  const [error, setError] = useState('')
  const hasExistingRecord = Boolean(debt?.id || repayment?.id)
  const repaymentsWithoutCurrent = repayments.filter((row) => row.id !== repayment?.id)
  const repaymentLimit = (item: Debt) => {
    if (repayment?.debtId === item.id) return repaymentBalanceLimit(item, repaymentsWithoutCurrent, { ...repayment, date })
    const limitDate = date > today() ? today() : date
    return calculateDebtBalance(item, repaymentsWithoutCurrent, limitDate).totalRemainingCents
  }
  const repaymentOptions = debts.filter((item) => repaymentLimit(item) > 0 || item.id === repayment?.debtId)
  const selectedRepaymentDebt = debts.find((item) => item.id === debtId)
  const repaymentLabel = selectedRepaymentDebt?.direction === 'owed' ? '收款' : '还款'
  const editorTitle = hasExistingRecord ? '编辑记录' : editor.kind === 'debt' ? '新增欠款' : `记${repaymentLabel}`

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    const item = editor.kind === 'debt' ? makeDebt(userId, { person, direction, amount, annualInterestRate, hasInterest, dueDate: hasDueDate ? dueDate : '', notes }, debt) : makeRepayment(userId, { debtId, amount, date, notes }, repayment)
    if (!item) { setError(editor.kind === 'debt' ? hasInterest ? '请填写对方、金额和正确的年利率。' : '请填写对方和正确的金额。' : '请填写债务、金额和日期。'); return }
    if ('debtId' in item) {
      const target = debts.find((row) => row.id === item.debtId)
      if (!target || item.amountCents > repaymentLimit(target)) { setError(`${repaymentLabel}金额不能超过该笔债务的剩余金额。`); return }
    }
    await onSave(item)
  }

  return <div className="scrim" role="presentation"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="editor-title"><div className="sheet-title"><h2 id="editor-title">{editorTitle}</h2><button onClick={onClose} aria-label="关闭"><X size={20} /></button></div><form onSubmit={submit}><label>对方{editor.kind === 'repayment' ? <div className="person-picker"><input aria-label="对方" value={selectedRepaymentDebt?.person ?? ''} readOnly /></div> : !debt && existingPeople.length && personMode === 'existing' ? <div className="person-picker"><select aria-label="选择已有欠款人" value={person} onChange={(event) => setPerson(event.target.value)}>{existingPeople.map((item) => <option value={item} key={item}>{item}</option>)}</select><button className="person-mode-button" type="button" onClick={() => { setPersonMode('new'); setPerson('') }} aria-label="新增欠款人"><Plus size={17} /></button></div> : <div className="person-picker"><input value={person} onChange={(event) => setPerson(event.target.value)} placeholder="例如：林晓" autoFocus={editor.kind === 'debt'} />{!debt && existingPeople.length > 0 && <button className="person-mode-button" type="button" onClick={() => { setPersonMode('existing'); setPerson(defaultDebtPerson(debts)) }} aria-label="选择已有欠款人"><Users size={17} /></button>}</div>}</label>{editor.kind === 'debt' && <label>方向<div className="segmented"><button type="button" className={direction === 'owe' ? 'selected' : ''} onClick={() => setDirection('owe')}>我欠别人</button><button type="button" className={direction === 'owed' ? 'selected' : ''} onClick={() => setDirection('owed')}>别人欠我</button></div></label>}{editor.kind === 'repayment' && <label>归属欠款{repaymentOptions.length ? <><select aria-label="归属欠款" value={debtId} onChange={(event) => setDebtId(event.target.value)}>{repaymentOptions.map((item) => <option value={item.id} key={item.id}>{item.person} · {recordDate(item).replaceAll('-', '.')} · {item.notes || '无备注'} · 剩余 {formatYuan(repaymentLimit(item))}</option>)}</select>{selectedRepaymentDebt && <span className="helper-text">可用余额：{formatYuan(repaymentLimit(selectedRepaymentDebt))}</span>}</> : <p className="empty-field" role="status">没有可{repaymentLabel}的未结清欠款。</p>}</label>}<label>{editor.kind === 'repayment' ? `${repaymentLabel}金额（元）` : '金额（元）'}<div className="input-prefix"><span>¥</span><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" required /></div></label>{editor.kind === 'debt' ? <><label className="interest-toggle"><span>包含利息<input type="checkbox" checked={hasInterest} onChange={(event) => setHasInterest(event.target.checked)} /></span>{hasInterest && <><input aria-label="年利率" type="number" step=".01" min=".01" max={MAX_ANNUAL_INTEREST_RATE_BPS / 100} value={annualInterestRate} onChange={(event) => setAnnualInterestRate(event.target.value)} placeholder="例如 5.5" required /><small>按剩余本金逐日单利，修改后从欠款发生日重算</small></>}</label><label>到期日<div className="due-date-control"><button type="button" className={!hasDueDate ? 'selected' : ''} onClick={() => { setHasDueDate(false); setDueDate('') }}>无</button><button type="button" className={hasDueDate ? 'selected' : ''} onClick={() => setHasDueDate(true)}>选择日期</button></div>{hasDueDate && <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />}</label></> : <label>{repaymentLabel}日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>}<label>备注（可选）<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="补充一点说明" rows={2} /></label>{error && <p className="error-message">{error}</p>}<button className="primary-button full" type="submit" disabled={editor.kind === 'repayment' && repaymentOptions.length === 0}><Check size={18} />保存记录</button>{hasExistingRecord && !String((debt || repayment)?.id).startsWith('demo-') && <button className="danger-button full" type="button" onClick={() => void onDelete((debt || repayment)!)}><Trash2 size={17} />删除记录</button>}</form></div></div>
}

function EmptyState({ title, description }: { title: string; description: string }) { return <div className="empty-state"><div className="empty-icon"><ReceiptText size={22} /></div><h3>{title}</h3><p>{description}</p></div> }
