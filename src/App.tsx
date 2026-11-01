import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Cloud, CloudOff, CreditCard, LogOut, Moon, Pencil, Plus, ReceiptText, RefreshCw, Settings, Sun, Trash2, UserRound, Users, Wallet, X } from 'lucide-react'
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
type DetailOrigin = 'overview' | 'bills'

const THEME_KEY = 'cleardues-theme'
const nowIso = () => new Date().toISOString()
const today = () => todayLocalDate()
const recordDate = (debt: Debt) => debtOccurredDate(debt)
const shortRecordDate = (debt: Debt) => { const [, month, day] = recordDate(debt).split('-'); return `${Number(month)}月${Number(day)}日` }
const monthLabel = (value: string) => { if (value === 'all') return '全部欠款'; const [year, month] = value.split('-'); return `${year}年${Number(month)}月` }
const monthOptions = () => Array.from({ length: 12 }, (_, index) => { const date = new Date(); date.setDate(1); date.setMonth(date.getMonth() - index); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` })
const initialTheme = (): Theme => { try { return window.localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' } }

const demoDebts: Debt[] = [
  { id: 'demo-1', userId: 'demo', person: '林晓', direction: 'owe', initialAmountCents: 180000, annualInterestRateBps: null, occurredDate: today(), dueDate: '2026-09-18', notes: '上次旅行垫付', deletedAt: null, updatedAt: nowIso() },
  { id: 'demo-2', userId: 'demo', person: '周然', direction: 'owed', initialAmountCents: 86000, annualInterestRateBps: null, occurredDate: today(), dueDate: '2026-09-12', notes: '餐费分摊', deletedAt: null, updatedAt: nowIso() },
]

function makeDebt(userId: string, form: { person: string; direction: Direction; amount: string; annualInterestRate: string; hasInterest: boolean; occurredDate: string; dueDate: string; notes: string }, existing?: Debt): Debt | null {
  const cents = parseAmountToCents(form.amount)
  const annualInterestRateBps = form.hasInterest ? parseAnnualInterestRateBps(form.annualInterestRate) : null
  if (!form.person.trim() || cents === null || cents <= 0 || (form.hasInterest && annualInterestRateBps === null)) return null
  const occurredDate = form.occurredDate || (existing ? debtOccurredDate(existing) : today())
  return { id: existing?.id ?? crypto.randomUUID(), userId, person: form.person.trim(), direction: form.direction, initialAmountCents: cents, annualInterestRateBps, occurredDate, dueDate: form.dueDate || null, notes: form.notes.trim(), deletedAt: null, updatedAt: nowIso() }
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
  const [selectedMonth, setSelectedMonth] = useState('all')
  const [debts, setDebts] = useState<Debt[]>(isDemoEnabled ? demoDebts : [])
  const [repayments, setRepayments] = useState<Repayment[]>([])
  const [editor, setEditor] = useState<Editor>(null)
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [detailOrigin, setDetailOrigin] = useState<DetailOrigin>('overview')
  const [repaymentChoices, setRepaymentChoices] = useState<DebtGroup | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState(supabaseConfigured ? '等待同步' : isDemoEnabled ? '本地演示' : '未配置同步')
  const [user, setUser] = useState<AuthUser | null>(null)
  const userId = user?.id ?? (isDemoEnabled ? 'demo' : null)

  useEffect(() => {
    try { window.localStorage.setItem(THEME_KEY, theme) } catch { /* storage is optional */ }
    document.documentElement.classList.toggle('theme-dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151515' : '#f7f6f1')
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
  const availableMonths = useMemo(() => ['all', ...new Set([...monthOptions(), ...visibleDebts.map((debt) => recordDate(debt).slice(0, 7))])], [visibleDebts])
  const selectedAsOf = useMemo(() => selectedMonth === 'all' ? today() : asOfForMonth(selectedMonth), [selectedMonth])
  const monthDebts = useMemo(() => selectedMonth === 'all' ? visibleDebts : filterDebtsByMonth(visibleDebts, selectedMonth), [visibleDebts, selectedMonth])
  const periodRepayments = useMemo(() => selectedMonth === 'all' ? visibleRepayments.filter((repayment) => repayment.date <= selectedAsOf) : filterRepaymentsThroughMonth(visibleRepayments, selectedMonth), [visibleRepayments, selectedMonth, selectedAsOf])
  const stats = useMemo(() => calculateStats(monthDebts, periodRepayments, new Date(`${(selectedMonth === 'all' ? selectedAsOf : selectedMonth).slice(0, 7)}-01T00:00:00Z`)), [monthDebts, periodRepayments, selectedAsOf, selectedMonth])
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
  async function signOut() {
    if (!supabase || !user) return
    try {
      const { error } = await supabase.auth.signOut()
      if (error) { setSyncMessage('退出登录失败，请稍后重试。'); return }
      setUser(null)
    } catch {
      setSyncMessage('退出登录失败，请检查网络后重试。')
    }
  }
  async function saveEditor(item: Debt | Repayment) {
    if (item.id.startsWith('demo-')) return
    if ('person' in item) { await saveDebtOffline(item); setDebts((current) => [...current.filter((row) => row.id !== item.id), item]) } else { await saveRepaymentOffline(item); setRepayments((current) => [...current.filter((row) => row.id !== item.id), item]) }
    if (supabase && user) { if (typeof navigator === 'undefined' || navigator.onLine) void syncNow(); else setSyncMessage('当前离线，修改将暂存本地') }
  }
  async function remove(item: Debt | Repayment): Promise<boolean> {
    if (item.id.startsWith('demo-')) return false
    if (typeof window !== 'undefined' && !window.confirm(`确定删除这笔${'person' in item ? '欠款' : '还款'}吗？`)) return false
    try {
      const updatedAt = nowIso(); await softDeleteOffline('person' in item ? 'debt' : 'repayment', item.id, updatedAt)
      if ('person' in item) setDebts((current) => current.map((row) => row.id === item.id ? { ...row, deletedAt: updatedAt, updatedAt } : row)); else setRepayments((current) => current.map((row) => row.id === item.id ? { ...row, deletedAt: updatedAt, updatedAt } : row))
      setDetailKey(null)
      if (supabase && user) { if (typeof navigator === 'undefined' || navigator.onLine) void syncNow(); else setSyncMessage('当前离线，修改将暂存本地') }
      return true
    } catch {
      setSyncMessage('删除失败，请稍后重试。')
      return false
    }
  }
  function openNew(kind: 'debt' | 'repayment') { setEditor({ kind }) }
  function openRepayment(debt: Debt) { setEditor({ kind: 'repayment', item: { debtId: debt.id } as Repayment }) }
  function openRepaymentGroup(group: DebtGroup) {
    setDetailKey(null)
    const openDebts = group.debts.filter((debt) => calculateDebtBalance(debt, visibleRepayments, group.asOf).totalRemainingCents > 0)
    if (openDebts.length === 1) openRepayment(openDebts[0]); else setRepaymentChoices(group)
  }
  function openDetails(key: string, origin: DetailOrigin) { setDetailOrigin(origin); setDetailKey(key) }
  if (!userId) return <LoginGate />

  return <div className={`app-shell theme-${theme}`}>
    {tab === 'overview' && <header className="topbar"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true"><Wallet size={20} /></span><div className="brand-copy"><h1>ClearDues</h1></div></div><div className="topbar-tools"><label className="month-select"><CalendarDays size={15} /><select aria-label="选择月份" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}>{availableMonths.map((value) => <option key={value} value={value}>{monthLabel(value)}</option>)}</select></label><div className="theme-toggle" role="group" aria-label="选择主题"><button className={theme === 'light' ? 'theme-choice selected' : 'theme-choice'} onClick={() => setTheme('light')} aria-label="亮色主题" aria-pressed={theme === 'light'}><Sun size={19} /></button><button className={theme === 'dark' ? 'theme-choice selected' : 'theme-choice'} onClick={() => setTheme('dark')} aria-label="暗色主题" aria-pressed={theme === 'dark'}><Moon size={19} /></button></div></div></header>}
    {tab === 'bills' && <header className="section-topbar bills-topbar"><div><h1>账单</h1></div><label className="month-select"><CalendarDays size={16} /><select aria-label="选择月份" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}>{availableMonths.map((value) => <option key={value} value={value}>{monthLabel(value)}</option>)}</select></label></header>}
    {tab === 'settings' && <header className="section-topbar settings-topbar"><h1>设置</h1><div className="settings-brand"><span aria-hidden="true"><Wallet size={14} /></span><strong>ClearDues</strong></div></header>}
    <main key={tab} className="page-content tab-transition">{tab === 'overview' && <Overview groups={groups} debts={monthDebts} stats={stats} month={selectedMonth} repayments={periodRepayments} asOf={selectedAsOf} onEdit={(item) => { setDetailKey(null); setEditor({ kind: 'debt', item }) }} onOpenDetails={(key) => openDetails(key, 'overview')} onRepay={openRepaymentGroup} />}{tab === 'bills' && <Bills groups={groups} onOpenDetails={(key) => openDetails(key, 'bills')} />}{tab === 'settings' && <SettingsPanel email={user?.email ?? null} authenticated={Boolean(user)} demo={isDemoEnabled && !user} theme={theme} setTheme={setTheme} syncing={syncing} syncMessage={syncMessage} configured={supabaseConfigured} onSyncNow={syncNow} onSignOut={signOut} />}</main>
    <div className="bottom-dock"><div className="bottom-actions"><button className="add-debt-button" onClick={() => openNew('debt')}><Plus size={18} />新增欠款</button></div><nav className="bottom-nav" aria-label="主导航"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><CreditCard size={19} /><span>总览</span></button><button className={tab === 'bills' ? 'active' : ''} onClick={() => setTab('bills')}><ReceiptText size={19} /><span>账单</span></button><button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Settings size={19} /><span>设置</span></button></nav></div>
    {repaymentChoices && <RepaymentChoiceModal group={repaymentChoices} repayments={visibleRepayments} onClose={() => setRepaymentChoices(null)} onChoose={(debt) => { setRepaymentChoices(null); openRepayment(debt) }} />}{editor && <EditorModal key={`${editor.kind}:${editor.item?.id ?? 'new'}`} editor={editor} userId={userId} debts={visibleDebts} repayments={visibleRepayments} onSave={saveEditor} onDelete={remove} onClose={() => setEditor(null)} />}{detailGroup && <DebtDetailModal group={detailGroup} repayments={periodRepayments} returnLabel={detailOrigin === 'bills' ? '返回账单' : '返回总览'} onClose={() => setDetailKey(null)} onEditDebt={(debt) => { setDetailKey(null); setEditor({ kind: 'debt', item: debt }) }} onDeleteDebt={remove} onAddRepayment={openRepaymentGroup} onEditRepayment={(item) => { setDetailKey(null); setEditor({ kind: 'repayment', item }) }} />}
  </div>
}

function Overview({ groups, debts, stats, month, repayments, asOf, onEdit, onOpenDetails, onRepay }: { groups: DebtGroup[]; debts: Debt[]; stats: ReturnType<typeof calculateStats>; month: string; repayments: Repayment[]; asOf: string; onEdit: (debt: Debt) => void; onOpenDetails: (key: string) => void; onRepay: (group: DebtGroup) => void }) {
  const personCount = new Set(groups.map((group) => group.person.trim().toLocaleLowerCase())).size
  const oweGroups = groups.filter((group) => group.direction === 'owe')
  const oweInterest = oweGroups.reduce((sum, group) => sum + group.interestRemaining, 0)
  const owePrincipal = Math.max(0, stats.oweBalanceCents - oweInterest)
  const oweCount = debts.filter((debt) => debt.direction === 'owe').length
  return <section className="overview-page"><div className="summary-card"><div className="summary-copy"><p className="card-kicker">{month === 'all' ? '全部待还' : month === today().slice(0, 7) ? '本月待还' : `${monthLabel(month)}待还`}</p><strong>{formatYuan(stats.oweBalanceCents)}</strong><span>本金 {formatYuan(owePrincipal)} · 利息 {formatYuan(oweInterest)} <i>· {oweCount} 笔欠款</i></span></div></div>{stats.owedBalanceCents > 0 && <div className="collection-note"><ArrowDownLeft size={17} /><span>待收 <strong>{formatYuan(stats.owedBalanceCents)}</strong></span></div>}{personCount > 1 && <div className="contacts-heading"><h2>全部往来</h2><span className="contacts-count">{personCount} 个往来</span></div>}{groups.length ? <div className="group-list">{groups.map((group) => <DebtSummaryCard key={group.key} group={group} onOpenDetails={() => onOpenDetails(group.key)} onRepay={() => onRepay(group)} />)}</div> : <EmptyState title="还没有欠款记录" description="从下方新增欠款开始，让每笔往来都有迹可循。" />}{groups.length > 0 && <DebtDetailsCard groups={groups} repayments={repayments} asOf={asOf} onEdit={onEdit} />}</section>
}

function DebtSummaryCard({ group, onOpenDetails, onRepay }: { group: DebtGroup; onOpenDetails: () => void; onRepay: () => void }) {
  const dueDates = group.debts.map((debt) => debt.dueDate).filter(Boolean) as string[]; const dueDate = dueDates.length ? dueDates.sort()[0].replaceAll('-', '.') : '无到期日'
  return <article className="debt-summary-card"><button type="button" className="debt-summary-main" onClick={onOpenDetails} aria-label="查看详情"><div className="debt-summary-head"><h2>{group.person}</h2><strong className="group-balance">{formatYuan(group.remaining)}</strong></div><div className="debt-summary-meta"><span>{dueDate}</span>{group.interestRemaining > 0 && <span>{group.direction === 'owe' ? '未付利息' : '待收利息'} {formatYuan(group.interestRemaining)}</span>}</div><div className="compact-progress"><div className="progress-track"><div style={{ width: `${group.progress * 100}%` }} /></div><span>{Math.round(group.progress * 100)}%</span></div></button><div className="debt-summary-footer"><span>{group.direction === 'owe' ? '已还' : '已收'} {formatYuan(group.paid)}</span>{group.remaining > 0 && <button type="button" className="quick-repayment" onClick={onRepay}>{group.direction === 'owe' ? '去还款' : '去收款'}<ArrowRight size={16} aria-hidden="true" /></button>}</div></article>
}

function DebtDetailsCard({ groups, repayments, asOf, onEdit }: { groups: DebtGroup[]; repayments: Repayment[]; asOf: string; onEdit: (debt: Debt) => void }) {
  const records = groups.flatMap((group) => group.debts.map((debt) => ({ debt, person: group.person }))).sort((a, b) => recordDate(b.debt).localeCompare(recordDate(a.debt)))
  const showPerson = new Set(records.map(({ person }) => person.trim().toLocaleLowerCase())).size > 1
  return <section className="details-card"><div className="details-card-head"><h2>欠款明细</h2></div><div className="debt-record-list">{records.map(({ debt, person }) => { const balance = calculateDebtBalance(debt, repayments, asOf); return <button type="button" className="debt-record" key={debt.id} onClick={() => onEdit(debt)} aria-label={`编辑欠款 ${person} ${shortRecordDate(debt)} ${formatYuan(balance.totalRemainingCents)} ${debt.notes || '无备注'}`}><span className="record-dot" aria-hidden="true" /><span className="record-copy"><span className="record-topline"><span className="record-date">{shortRecordDate(debt)}</span>{showPerson && <strong className="record-person">{person}</strong>}<strong className="record-amount">{formatYuan(balance.totalRemainingCents)}</strong></span><span className="record-bottomline"><small className="record-note">{debt.notes || '无备注'}</small>{debt.annualInterestRateBps != null && <small className="record-interest">{debt.direction === 'owe' ? '未付利息' : '待收利息'} {formatYuan(balance.interestRemainingCents)}</small>}</span></span><ChevronRight className="record-chevron" size={18} aria-hidden="true" /></button> })}</div></section>
}

function Bills({ groups, onOpenDetails }: { groups: DebtGroup[]; onOpenDetails: (key: string) => void }) {
  const [filter, setFilter] = useState<'all' | 'owe' | 'owed' | 'settled'>('all')
  const debtCount = groups.reduce((sum, group) => sum + group.debts.length, 0)
  const totalOwe = groups.filter((group) => group.direction === 'owe').reduce((sum, group) => sum + group.remaining, 0)
  const totalOwed = groups.filter((group) => group.direction === 'owed').reduce((sum, group) => sum + group.remaining, 0)
  const visibleGroups = groups.filter((group) => filter === 'all' || (filter === 'owe' && group.direction === 'owe' && group.remaining > 0) || (filter === 'owed' && group.direction === 'owed' && group.remaining > 0) || (filter === 'settled' && group.remaining === 0))
  const visibleGroupKeys = new Set(visibleGroups.map((group) => group.key))
  const filters = [['all', '全部'], ['owe', '待还'], ['owed', '待收'], ['settled', '已结清']] as const
  const filterIndex = filters.findIndex(([value]) => value === filter)
  return <section className="bills-page">
    <div className="bills-summary"><div className="bills-totals"><div><span>待还总额</span><strong>{formatYuan(totalOwe)}</strong></div><div><span>待收总额</span><strong>{formatYuan(totalOwed)}</strong></div></div><p>共 {groups.length} 个往来 · {debtCount} 笔欠款</p></div>
    <div className="bills-filters" role="group" aria-label="账单状态筛选"><span className="bills-filter-indicator" aria-hidden="true" style={{ transform: `translateX(${filterIndex * 100}%)` }} />{filters.map(([value, label]) => <button type="button" key={value} className={filter === value ? 'selected' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    <div className="bills-list">{groups.map((group) => { const visible = visibleGroupKeys.has(group.key); return <div className={`bill-list-item${visible ? ' is-visible' : ' is-hidden'}`} key={group.key} aria-hidden={!visible} inert={!visible}><div className="bill-list-item-inner"><BillCard group={group} onOpenDetails={() => onOpenDetails(group.key)} /></div></div> })}<div className={`bill-list-item${visibleGroups.length ? ' is-hidden' : ' is-visible'}`} key="empty" aria-hidden={Boolean(visibleGroups.length)} inert={Boolean(visibleGroups.length)}><div className="bill-list-item-inner"><EmptyState title={groups.length ? '没有符合条件的往来' : '暂无账单记录'} description={groups.length ? '试试其他状态筛选。' : '从下方新增欠款开始记录第一笔往来。'} /></div></div></div>
  </section>
}

function BillCard({ group, onOpenDetails }: { group: DebtGroup; onOpenDetails: () => void }) {
  const dueDates = group.debts.map((debt) => debt.dueDate).filter(Boolean) as string[]
  const dueDate = dueDates.length ? `${dueDates.sort()[0].replaceAll('-', '.')} 到期` : '无到期日'
  const hasInterest = group.debts.some((debt) => debt.annualInterestRateBps != null)
  const interestLabel = group.direction === 'owe' ? '未付利息' : '待收利息'
  const principal = Math.max(0, group.remaining - group.interestRemaining)
  return <button type="button" className="bill-card" onClick={onOpenDetails} aria-label={`查看 ${group.person} 详情，${formatYuan(group.remaining)}`}>
    <span className="bill-icon"><Wallet size={28} /></span><span className="bill-copy"><strong>{group.person}</strong><small>{group.direction === 'owe' ? '我欠对方' : '对方欠我'} · {group.debts.length} 笔欠款</small></span><span className="bill-amount-wrap"><strong className="bill-amount">{formatYuan(group.remaining)} <ChevronRight size={18} aria-hidden="true" /></strong><small className="bill-amount-label">{group.direction === 'owe' ? '剩余应还' : '剩余应收'}</small></span><span className="bill-info-line"><small className="bill-due-date">{dueDate}</small>{hasInterest && <> <span className="bill-info-separator" aria-hidden="true">·</span> <small className="bill-interest-summary">本金 {formatYuan(principal)} · {interestLabel} {formatYuan(group.interestRemaining)}</small></>}</span>
    <span className="bill-progress"><span className="progress-track"><span style={{ width: `${group.progress * 100}%` }} /></span><small>{Math.round(group.progress * 100)}%</small></span>
  </button>
}

function AnimatedLayer({ className, role, onClose, duration = 180, children }: { className: string; role?: string; onClose: () => void; duration?: number; children: (requestClose: () => void, closing: boolean) => React.ReactNode }) {
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  function requestClose() {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    timer.current = setTimeout(onClose, reducedMotion ? 0 : duration)
  }
  return <div className={`${className}${closing ? ' is-closing' : ''}`} role={role}>{children(requestClose, closing)}</div>
}

export function RepaymentChoiceModal({ group, repayments, onClose, onChoose }: { group: DebtGroup; repayments: Repayment[]; onClose: () => void; onChoose: (debt: Debt) => void }) {
  const openDebts = group.debts.filter((debt) => calculateDebtBalance(debt, repayments, group.asOf).totalRemainingCents > 0)
  const [selectedId, setSelectedId] = useState(openDebts[0]?.id ?? '')
  const submitted = useRef(false)
  const selectedDebt = openDebts.find((debt) => debt.id === selectedId)
  function continueToRepayment() {
    if (submitted.current || !selectedDebt) return
    submitted.current = true
    onChoose(selectedDebt)
  }
  return <AnimatedLayer className="scrim" role="presentation" onClose={onClose} duration={180}>{(requestClose, closing) => <div className="modal-card choice-modal" role="dialog" aria-modal="true" aria-labelledby="choice-title" inert={closing}><div className="sheet-handle" aria-hidden="true" /><div className="sheet-title"><div><h2 id="choice-title">{group.direction === 'owe' ? `给${group.person}还款` : `向${group.person}收款`}</h2><p>选择一笔欠款</p></div><button type="button" onClick={requestClose} aria-label="关闭"><X size={20} /></button></div>{openDebts.length ? <><div className="choice-list" role="radiogroup" aria-label="选择一笔欠款">{openDebts.map((debt) => { const balance = calculateDebtBalance(debt, repayments, group.asOf).totalRemainingCents; const selected = selectedId === debt.id; const index = openDebts.findIndex((item) => item.id === debt.id); return <button type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} className={`choice-row${selected ? ' selected' : ''}`} key={debt.id} onClick={() => setSelectedId(debt.id)} onKeyDown={(event) => { if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? openDebts.length - 1 : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + openDebts.length) % openDebts.length; setSelectedId(openDebts[nextIndex].id); (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex])?.focus() }}><span className="choice-copy"><strong>{debt.notes || '无备注'}</strong><small>{recordDate(debt).replaceAll('-', '.')}</small></span><span className="choice-balance"><strong>{formatYuan(balance)}</strong><small>{group.direction === 'owe' ? '待还金额' : '待收金额'}</small></span><span className="choice-radio" aria-hidden="true" /></button> })}</div><div className="choice-footer"><p>已选：<strong>{selectedDebt?.notes || '无备注'}</strong></p><button type="button" className="primary-button full" disabled={!selectedDebt || submitted.current || closing} onClick={continueToRepayment}>下一步 <ChevronRight size={18} /></button></div></> : <div className="choice-empty" role="status"><p>这些欠款已结清，无需再记录{group.direction === 'owe' ? '还款' : '收款'}。</p><button className="outline-button" type="button" onClick={requestClose}>关闭</button></div>}</div>}</AnimatedLayer>
}

function DebtDetailModal({ group, repayments, returnLabel, onClose, onEditDebt, onDeleteDebt, onAddRepayment, onEditRepayment }: { group: DebtGroup; repayments: Repayment[]; returnLabel: string; onClose: () => void; onEditDebt: (debt: Debt) => void; onDeleteDebt: (item: Debt) => Promise<boolean>; onAddRepayment: (group: DebtGroup) => void; onEditRepayment: (repayment: Repayment) => void }) {
  const [expandedDebtIds, setExpandedDebtIds] = useState<Set<string>>(() => new Set())
  const records = group.debts.flatMap((debt) => repayments.filter((item) => item.debtId === debt.id)).sort((a, b) => b.date.localeCompare(a.date))
  const principalRemaining = Math.max(0, group.remaining - group.interestRemaining)
  return <AnimatedLayer className="detail-scrim" onClose={onClose} role="presentation">{(requestClose, closing) => <div className="detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title" inert={closing}><header className="detail-header"><button type="button" onClick={requestClose} aria-label="关闭"><ChevronLeft size={24} /></button><div><h2 id="detail-title">{group.person}</h2><span>往来详情</span></div></header><div className="detail-modal-content"><section className="detail-balance"><span className="detail-balance-label">{group.direction === 'owe' ? '还需支付' : '还需收回'}</span><strong className="detail-balance-total">{formatYuan(group.remaining)}</strong><div className="detail-breakdown"><div><span>本金</span><strong>{formatYuan(principalRemaining)}</strong></div><div><span>{group.direction === 'owe' ? '未付利息' : '待收利息'}</span><strong>{formatYuan(group.interestRemaining)}</strong></div></div><div className="detail-progress-row"><div className="progress-track"><div style={{ width: `${group.progress * 100}%` }} /></div><span>{group.direction === 'owe' ? '已还' : '已收'} {Math.round(group.progress * 100)}%</span></div></section><section className="detail-section"><h3>欠款明细</h3><div className="detail-record-card">{group.debts.map((debt) => { const balance = debtBalance(debt, repayments, group.asOf); const isExpanded = expandedDebtIds.has(debt.id); const note = debt.notes || '无备注'; return <div className="detail-debt-row" key={debt.id}><div className="detail-row-top"><strong className="detail-row-date">{recordDate(debt).replaceAll('-', '.')}</strong><strong className="detail-row-amount">{formatYuan(balance.totalRemainingCents)}</strong></div><div className="detail-row-bottom"><button type="button" className="detail-row-note" aria-expanded={isExpanded} onClick={() => setExpandedDebtIds((current) => { const next = new Set(current); if (next.has(debt.id)) next.delete(debt.id); else next.add(debt.id); return next })}><small title={note}>{note}</small></button><div className="detail-row-actions">{debt.annualInterestRateBps != null && <span className="detail-row-interest-amount">{debt.direction === 'owe' ? '未付利息' : '待收利息'} {formatYuan(balance.interestRemainingCents)}</span>}<button type="button" className="row-action" onClick={() => onEditDebt(debt)} aria-label={`编辑欠款 ${group.person}`}><Pencil size={15} /></button><button type="button" className="row-action danger" onClick={() => void onDeleteDebt(debt)} aria-label={`删除欠款 ${group.person}`}><Trash2 size={15} /></button></div></div>{isExpanded && debt.annualInterestRateBps != null && <div className="detail-row-interest"><span>本金 {formatYuan(balance.principalRemainingCents)}</span><span>累计利息 {formatYuan(balance.totalAccruedInterestCents)}</span><span>{debt.direction === 'owe' ? '未付利息' : '待收利息'} {formatYuan(balance.interestRemainingCents)}</span><span>年利率 {formatAnnualInterestRate(debt.annualInterestRateBps)}%</span></div>}</div> })}</div></section><section className="detail-section repayment-section"><h3>{group.direction === 'owe' ? '还款流水' : '收款流水'}</h3><div className="repayment-card">{records.length ? records.map((item) => <button type="button" className="repayment-row" key={item.id} onClick={() => onEditRepayment(item)}><span>{item.date.replaceAll('-', '.')}</span><span>{item.notes || (group.direction === 'owe' ? '还款' : '收款')}</span><strong>{formatYuan(item.amountCents)}</strong><ChevronRight size={15} /></button>) : <p className="detail-empty">还没有流水记录。</p>}</div></section></div><footer className="detail-footer"><button type="button" className="detail-return-button" onClick={requestClose}><ChevronLeft size={18} aria-hidden="true" />{returnLabel}</button>{group.remaining > 0 && <button type="button" className="detail-repayment-cta" onClick={() => onAddRepayment(group)}><Plus size={20} />{group.direction === 'owe' ? '记还款' : '记收款'}</button>}</footer></div>}</AnimatedLayer>
}

function LoginGate() {
  const [mode, setMode] = useState<'login' | 'signup'>('login'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState(''); const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null); const [submitting, setSubmitting] = useState(false); const isSignup = mode === 'signup'
  function switchMode(nextMode: 'login' | 'signup') { setMode(nextMode); setMessage(null); setConfirmPassword('') }
  async function submit(event: React.FormEvent) { event.preventDefault(); setMessage(null); const cleanEmail = email.trim(); if (isSignup && password !== confirmPassword) { setMessage({ kind: 'error', text: '两次输入的密码不一致。' }); return }; setSubmitting(true); let result; try { result = isSignup ? await signUpWithPassword(cleanEmail, password) : await signInWithPassword(cleanEmail, password) } catch { setSubmitting(false); setMessage({ kind: 'error', text: '当前无法连接认证服务，请检查网络后重试。' }); return }; setSubmitting(false); if (result.error) { setMessage({ kind: 'error', text: result.error }); return }; setMessage({ kind: 'success', text: isSignup && result.needsEmailConfirmation ? '注册成功。请打开确认邮件完成邮箱验证，然后返回这里登录；应用不会发送登录链接。' : isSignup ? '注册成功，正在进入账本…' : '登录成功，正在进入账本…' }) }
  return <main className="auth-gate"><div className="auth-card"><div className="auth-intro"><div className="auth-brand"><span>ClearDues</span></div><p className="eyebrow">个人欠款账本</p><h1>把每笔往来记清楚</h1><p>记录欠款、还款和到期日，让账目清楚，心里轻松。</p></div>{supabaseConfigured ? <><div className="auth-mode" role="tablist" aria-label="认证方式"><button type="button" role="tab" aria-selected={!isSignup} className={!isSignup ? 'selected' : ''} onClick={() => switchMode('login')}>登录</button><button type="button" role="tab" aria-selected={isSignup} className={isSignup ? 'selected' : ''} onClick={() => switchMode('signup')}>注册</button></div><form className="auth-form" onSubmit={submit}><label htmlFor="auth-email">邮箱地址<input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" required /></label><label htmlFor="auth-password">密码<input id="auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 6 位字符" autoComplete={isSignup ? 'new-password' : 'current-password'} minLength={6} required /></label>{isSignup && <label htmlFor="auth-confirm-password">确认密码<input id="auth-confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入密码" autoComplete="new-password" minLength={6} required /></label>}<button className="primary-button full auth-submit" type="submit" disabled={submitting}>{submitting ? '处理中…' : isSignup ? '创建账号' : '登录账本'}</button>{message && <p className={`${message.kind === 'error' ? 'error-message' : 'form-message'} auth-message`} role="status">{message.text}</p>}</form><p className="auth-note">邮箱+密码登录 · 数据仅同步到你的 Supabase 账号</p></> : <div className="notice-card"><CloudOff size={18} /><div><strong>同步尚未配置</strong><p>请复制 .env.example 为 .env.local，填入 Supabase URL 和 Publishable Key。未配置时不会显示或写入账目。</p></div></div>}</div></main>
}

function SettingsPanel({ email, authenticated, demo, theme, setTheme, syncing, syncMessage, configured, onSyncNow, onSignOut }: { email: string | null; authenticated: boolean; demo: boolean; theme: Theme; setTheme: (theme: Theme) => void; syncing: boolean; syncMessage: string; configured: boolean; onSyncNow: () => Promise<void>; onSignOut: () => Promise<void> }) {
  const syncState = syncing ? 'busy' : syncMessage.includes('失败') ? 'error' : syncMessage.includes('离线') ? 'offline' : configured && authenticated && syncMessage === '已同步' ? 'on' : ''
  const accountStatus = authenticated ? '已登录' : demo ? '本地演示' : '未登录'
  const syncDisabled = syncing || !configured || !authenticated
  return <section className="settings-page">
    <div className="settings-account"><span className="settings-account-icon"><UserRound size={34} /></span><span className="settings-account-copy"><strong>我的账户</strong><small>{email ?? (demo ? '本地演示账户' : '未登录')}</small></span><span className={`account-status${authenticated ? ' authenticated' : ''}`}>{accountStatus}</span></div>
    <section className="settings-section"><h2>偏好</h2><div className="settings-card preference-card"><div className="setting-row"><span className="setting-icon"><Sun size={20} /></span><span className="setting-label"><strong>外观主题</strong></span><div className="theme-toggle" role="group" aria-label="选择主题"><button className={theme === 'light' ? 'theme-choice selected' : 'theme-choice'} onClick={() => setTheme('light')} aria-label="亮色主题" aria-pressed={theme === 'light'}><Sun size={19} /></button><button className={theme === 'dark' ? 'theme-choice selected' : 'theme-choice'} onClick={() => setTheme('dark')} aria-label="暗色主题" aria-pressed={theme === 'dark'}><Moon size={19} /></button></div></div><div className="setting-row"><span className="setting-icon"><span className="currency-symbol">¥</span></span><span className="setting-label"><strong>金额单位</strong></span><span className="currency-value">人民币 CNY</span></div></div></section>
    <section className="settings-section"><h2>数据与同步</h2><div className="settings-card sync-card"><div className="sync-status-row"><span className="setting-icon"><Cloud size={20} /></span><span className="sync-copy"><strong>跨设备同步</strong><small>{syncMessage}</small></span><span className={`status-dot ${syncState}`} /></div><button type="button" className="sync-now" disabled={syncDisabled} onClick={() => void onSyncNow()}><RefreshCw size={20} /><span>立即同步</span><ChevronRight size={18} /></button></div></section>
    <button className="signout-button" type="button" disabled={!authenticated} onClick={() => void onSignOut()}><LogOut size={20} />退出登录</button>
  </section>
}


function defaultInterestForPerson(debts: Debt[], person: string) {
  const latest = debts.filter((item) => !item.deletedAt && item.person.trim().toLocaleLowerCase() === person.trim().toLocaleLowerCase()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return latest?.annualInterestRateBps != null ? { hasInterest: true, annualInterestRate: formatAnnualInterestRate(latest.annualInterestRateBps) } : { hasInterest: false, annualInterestRate: '' }
}

function EditorModal({ editor, userId, debts, repayments, onSave, onDelete, onClose }: { editor: Exclude<Editor, null>; userId: string; debts: Debt[]; repayments: Repayment[]; onSave: (item: Debt | Repayment) => Promise<void>; onDelete: (item: Debt | Repayment) => Promise<boolean>; onClose: () => void }) {
  const debt = editor.kind === 'debt' ? editor.item as Debt | undefined : undefined
  const repayment = editor.kind === 'repayment' ? editor.item as Repayment | undefined : undefined
  const existingPeople = uniqueDebtPeople(debts)
  const defaultPerson = debt?.person ?? (editor.kind === 'debt' ? defaultDebtPerson(debts) : '')
  const initialInterest = debt ? { hasInterest: debt.annualInterestRateBps != null, annualInterestRate: formatAnnualInterestRate(debt.annualInterestRateBps) } : defaultInterestForPerson(debts, defaultPerson)
  const [person, setPerson] = useState(defaultPerson)
  const [personMode, setPersonMode] = useState<'existing' | 'new'>(debt || !existingPeople.length ? 'new' : 'existing')
  const [direction, setDirection] = useState<Direction>(debt?.direction ?? 'owe')
  const [amount, setAmount] = useState(debt ? formatCents(debt.initialAmountCents) : repayment && Number.isFinite(repayment.amountCents) ? formatCents(repayment.amountCents) : '')
  const [hasInterest, setHasInterest] = useState(initialInterest.hasInterest)
  const [annualInterestRate, setAnnualInterestRate] = useState(initialInterest.annualInterestRate)
  const [rateTouched, setRateTouched] = useState(false)
  const [occurredDate, setOccurredDate] = useState(debt ? debtOccurredDate(debt) : today())
  const [dueDate, setDueDate] = useState(debt?.dueDate ?? '')
  const [hasDueDate, setHasDueDate] = useState(Boolean(debt?.dueDate))
  const [date, setDate] = useState(repayment?.date ?? today())
  const [debtId, setDebtId] = useState(repayment?.debtId ?? debts.find((item) => remainingCents(item, repayments) > 0)?.id ?? '')
  const [notes, setNotes] = useState(debt?.notes ?? repayment?.notes ?? '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const closeRef = useRef<() => void>(() => undefined)
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
  const repaymentIsLocked = editor.kind === 'repayment' && !repayment?.id && Boolean(repayment?.debtId)
  const repaymentAsOf = date > today() ? today() : date
  const selectedBalance = selectedRepaymentDebt ? calculateDebtBalance(selectedRepaymentDebt, repaymentsWithoutCurrent, repaymentAsOf, repayment?.id ? { excludeRepaymentId: repayment.id, throughRepayment: { id: repayment.id, date, updatedAt: repayment.updatedAt } } : {}) : null
  const inheritedInterestDebt = debts.filter((item) => !item.deletedAt && item.person.trim().toLocaleLowerCase() === person.trim().toLocaleLowerCase()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const showInheritedInterest = !debt && !rateTouched && hasInterest && inheritedInterestDebt?.direction === direction && inheritedInterestDebt.annualInterestRateBps != null && parseAnnualInterestRateBps(annualInterestRate) === inheritedInterestDebt.annualInterestRateBps

  function applyPersonDefaults(nextPerson: string) {
    const next = defaultInterestForPerson(debts, nextPerson)
    setHasInterest(next.hasInterest)
    setAnnualInterestRate(next.annualInterestRate)
    setRateTouched(false)
  }
  function selectPerson(nextPerson: string) { setPerson(nextPerson); applyPersonDefaults(nextPerson) }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (submitting) return; setSubmitting(true); setError('')
    const item = editor.kind === 'debt' ? makeDebt(userId, { person, direction, amount, annualInterestRate, hasInterest, occurredDate, dueDate: hasDueDate ? dueDate : '', notes }, debt) : makeRepayment(userId, { debtId, amount, date, notes }, repayment)
    if (!item) { setError(editor.kind === 'debt' ? hasInterest ? '请填写对方、金额、发生日期和正确的年利率。' : '请填写对方、金额和发生日期。' : '请填写债务、金额和日期。'); setSubmitting(false); return }
    if ('debtId' in item) {
      const target = debts.find((row) => row.id === item.debtId)
      if (!target || item.amountCents > repaymentLimit(target)) { setError(`${repaymentLabel}金额不能超过该笔债务的剩余金额。`); setSubmitting(false); return }
    }
    try { await onSave(item); closeRef.current() } catch { setError('保存失败，请稍后重试。'); setSubmitting(false) }
  }
  async function deleteCurrent(requestClose: () => void) {
    if (submitting || (!debt && !repayment)) return
    setSubmitting(true)
    try {
      const deleted = await onDelete((debt || repayment)!)
      if (deleted) requestClose(); else setSubmitting(false)
    } catch { setError('删除失败，请稍后重试。'); setSubmitting(false) }
  }

  return <AnimatedLayer className="scrim" role="presentation" onClose={onClose} duration={180}>{(requestClose, closing) => { closeRef.current = requestClose; return <div className="modal-card editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title" inert={closing}><div className="sheet-handle" aria-hidden="true" /><div className={`sheet-title${editor.kind === 'repayment' ? ' repayment-editor-heading' : ''}`}><h2 id="editor-title">{editorTitle}</h2><button type="button" onClick={requestClose} aria-label="关闭"><X size={20} /></button></div>{editor.kind === 'debt' ? <form className="debt-editor-form" onSubmit={submit}>
        <div className="segmented debt-direction" role="group" aria-label="欠款方向"><button type="button" className={direction === 'owe' ? 'selected' : ''} aria-pressed={direction === 'owe'} onClick={() => setDirection('owe')}>我欠别人</button><button type="button" className={direction === 'owed' ? 'selected' : ''} aria-pressed={direction === 'owed'} onClick={() => setDirection('owed')}>别人欠我</button></div>
        <label className="debt-amount-card">欠款金额（元）<div className="input-prefix debt-amount-input"><span>¥</span><input aria-label="欠款金额（元）" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" required /></div></label>
        <div className="debt-fields-card">
          <div className="debt-field-row"><Wallet size={20} aria-hidden="true" /><span>对方</span><div className="debt-field-value person-picker">{!debt && existingPeople.length && personMode === 'existing' ? <select aria-label="选择已有欠款人" value={person} onChange={(event) => selectPerson(event.target.value)}>{existingPeople.map((item) => <option value={item} key={item}>{item}</option>)}</select> : <input aria-label="对方" value={person} onChange={(event) => { setPerson(event.target.value); if (!debt) applyPersonDefaults('') }} placeholder="例如：林晓" autoFocus={!debt} />}{!debt && existingPeople.length > 0 && <ChevronRight className="person-picker-chevron" size={16} aria-hidden="true" />} {!debt && existingPeople.length > 0 && <button className="person-mode-button" type="button" onClick={() => { if (personMode === 'existing') { setPersonMode('new'); setPerson(''); applyPersonDefaults('') } else { setPersonMode('existing'); selectPerson(defaultDebtPerson(debts)) } }} aria-label={personMode === 'existing' ? '新增欠款人' : '选择已有欠款人'}>{personMode === 'existing' ? <Plus size={17} /> : <Users size={17} />}</button>}</div></div>
          <label className="debt-field-row"><CalendarDays size={20} aria-hidden="true" /><span>发生日期</span><input aria-label="发生日期" type="date" value={occurredDate} onChange={(event) => setOccurredDate(event.target.value)} required /></label>
          <div className="debt-field-row"><CalendarDays size={20} aria-hidden="true" /><span>到期日</span><div className="debt-field-value">{hasDueDate ? <><input aria-label="到期日期" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /><button type="button" className="due-date-clear" onClick={() => { setHasDueDate(false); setDueDate('') }} aria-label="设为无到期日"><X size={16} /></button></> : <button type="button" className="due-date-empty" onClick={() => setHasDueDate(true)}>无到期日 <ChevronRight size={16} aria-hidden="true" /></button>}</div></div>
        </div>
        <div className="interest-card"><label className="interest-card-toggle"><span>计息</span><span className="interest-switch"><input type="checkbox" aria-label="包含利息" checked={hasInterest} onChange={(event) => { setHasInterest(event.target.checked); if (!event.target.checked) setAnnualInterestRate('') }} /><span aria-hidden="true" /></span></label>{hasInterest && <label className="interest-rate-row">年利率<input aria-label="年利率" type="number" step=".01" min=".01" max={MAX_ANNUAL_INTEREST_RATE_BPS / 100} value={annualInterestRate} onChange={(event) => { setAnnualInterestRate(event.target.value); setRateTouched(true) }} placeholder="例如 5.5" required /><span>%</span><ChevronRight size={16} aria-hidden="true" /></label>}{showInheritedInterest && <small className="interest-inherited">已沿用该对象的计息设置</small>}</div>
        <label className="debt-notes-card">备注（可选）<textarea aria-label="备注" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="补充一点说明…" rows={2} /></label>
        {error && <p className="error-message">{error}</p>}<EditorFooter editor={editor} hasExistingRecord={hasExistingRecord} repaymentLabel={repaymentLabel} submitting={submitting} onDelete={() => void deleteCurrent(requestClose)} /></form> : <form className="repayment-editor-form" onSubmit={submit}>
        <div className="repayment-context"><span className="repayment-context-icon"><Wallet size={24} /></span><span className="repayment-context-copy"><strong>{selectedRepaymentDebt?.person ?? '选择欠款'}</strong><small>{selectedRepaymentDebt ? `${selectedRepaymentDebt.notes || '无备注'} · ${recordDate(selectedRepaymentDebt).replaceAll('-', '.')}` : '未选择债务'}</small></span></div>
        {!repaymentIsLocked && <label className="repayment-debt-select">归属欠款<select aria-label="归属欠款" value={debtId} onChange={(event) => setDebtId(event.target.value)}>{repaymentOptions.map((item) => <option value={item.id} key={item.id}>{item.person} · {recordDate(item).replaceAll('-', '.')} · {item.notes || '无备注'}</option>)}</select></label>}
        <section className="repayment-amount-card" aria-label={`本次${repaymentLabel}`}><label className="repayment-amount-label" htmlFor="repayment-amount">本次{repaymentLabel}</label><div className="repayment-amount-entry"><span className="input-prefix repayment-amount-input"><span>¥</span><input id="repayment-amount" aria-label={`${repaymentLabel}金额（元）`} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" required /></span>{selectedRepaymentDebt && <button type="button" className="settle-all-button" aria-label={`${repaymentLabel === '还款' ? '全部还清' : '全部收齐'} ${formatCents(repaymentLimit(selectedRepaymentDebt))} 元`} disabled={repaymentLimit(selectedRepaymentDebt) <= 0} onClick={() => setAmount(formatCents(repaymentLimit(selectedRepaymentDebt)))}>{repaymentLabel === '还款' ? '全部还清' : '全部收齐'}</button>}</div>{selectedRepaymentDebt && <p className="repayment-current-balance">当前待{repaymentLabel === '还款' ? '还' : '收'} {formatYuan(repaymentLimit(selectedRepaymentDebt))}</p>}{selectedBalance && <p className="repayment-balance">本金 {formatYuan(selectedBalance.principalRemainingCents)} · {repaymentLabel === '还款' ? '未付' : '待收'}利息 {formatYuan(selectedBalance.interestRemainingCents)}</p>}</section>
        <label className="repayment-date-row"><CalendarDays size={20} aria-hidden="true" /><span>{repaymentLabel}日期</span><input aria-label={`${repaymentLabel}日期`} type="date" value={date} onChange={(event) => setDate(event.target.value)} required /><ChevronRight size={16} aria-hidden="true" /></label>
        <label className="repayment-notes-card">备注（选填）<textarea aria-label="备注" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="写点说明…" rows={2} /></label>
        {error && <p className="error-message">{error}</p>}<EditorFooter editor={editor} hasExistingRecord={hasExistingRecord} repaymentLabel={repaymentLabel} submitting={submitting} onDelete={() => void deleteCurrent(requestClose)} /></form>}</div> } }</AnimatedLayer>
}

function EditorFooter({ editor, hasExistingRecord, repaymentLabel, submitting, onDelete }: { editor: Exclude<Editor, null>; hasExistingRecord: boolean; repaymentLabel: string; submitting: boolean; onDelete: () => void }) {
  const label = editor.kind === 'debt' ? hasExistingRecord ? '保存欠款' : '确认新增欠款' : hasExistingRecord ? `保存${repaymentLabel}` : `确认${repaymentLabel}`
  return <div className="editor-footer"><button className="primary-button full" type="submit" disabled={submitting}><Check size={18} />{label}</button>{hasExistingRecord && !String(editor.item?.id ?? '').startsWith('demo-') && <button className="danger-button subtle-delete" type="button" disabled={submitting} onClick={onDelete}><Trash2 size={17} />删除记录</button>}</div>
}

function EmptyState({ title, description }: { title: string; description: string }) { return <div className="empty-state"><div className="empty-icon"><ReceiptText size={22} /></div><h3>{title}</h3><p>{description}</p></div> }
