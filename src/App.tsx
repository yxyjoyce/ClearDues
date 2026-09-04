import { useEffect, useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, CalendarDays, Check, ChevronRight, Cloud, CloudOff, CreditCard, Pencil, Plus, ReceiptText, Settings, Trash2, X } from 'lucide-react'
import { readLocalLedger, saveDebtOffline, saveRepaymentOffline, softDeleteOffline } from './db'
import { formatCents, formatYuan, parseAmountToCents } from './money'
import { calculateStats, repaymentProgress, remainingCents } from './stats'
import { isDemoEnabled, signInWithPassword, signUpWithPassword, supabase, supabaseConfigured } from './supabase'
import { syncLedger } from './sync'
import type { Debt, Direction, Repayment } from './types'
import './styles.css'

type Tab = 'overview' | 'bills' | 'settings'
type Editor = { kind: 'debt' | 'repayment'; item?: Debt | Repayment } | null
type AuthUser = { id: string; email: string | null }

const nowIso = () => new Date().toISOString()
const today = () => new Date().toISOString().slice(0, 10)
const demoDebts: Debt[] = [
  { id: 'demo-1', userId: 'demo', person: '林晓', direction: 'owe', initialAmountCents: 180000, dueDate: '2026-09-18', notes: '上次旅行垫付', deletedAt: null, updatedAt: nowIso() },
  { id: 'demo-2', userId: 'demo', person: '周然', direction: 'owed', initialAmountCents: 86000, dueDate: '2026-09-12', notes: '餐费分摊', deletedAt: null, updatedAt: nowIso() },
]

function makeDebt(userId: string, form: { person: string; direction: Direction; amount: string; dueDate: string; notes: string }, existing?: Debt): Debt | null {
  const cents = parseAmountToCents(form.amount)
  if (!form.person.trim() || cents === null || cents <= 0) return null
  return { id: existing?.id ?? crypto.randomUUID(), userId, person: form.person.trim(), direction: form.direction, initialAmountCents: cents, dueDate: form.dueDate || null, notes: form.notes.trim(), deletedAt: null, updatedAt: nowIso() }
}

function makeRepayment(userId: string, form: { debtId: string; amount: string; date: string; notes: string }, existing?: Repayment): Repayment | null {
  const cents = parseAmountToCents(form.amount)
  if (!form.debtId || cents === null || cents <= 0 || !form.date) return null
  return { id: existing?.id ?? crypto.randomUUID(), userId, debtId: form.debtId, amountCents: cents, date: form.date, notes: form.notes.trim(), deletedAt: null, updatedAt: nowIso() }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [debts, setDebts] = useState<Debt[]>(isDemoEnabled ? demoDebts : [])
  const [repayments, setRepayments] = useState<Repayment[]>([])
  const [editor, setEditor] = useState<Editor>(null)
  const [showActions, setShowActions] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState(supabaseConfigured ? '等待同步' : isDemoEnabled ? '本地演示' : '未配置同步')
  const [user, setUser] = useState<AuthUser | null>(null)
  const userId = user?.id ?? (isDemoEnabled ? 'demo' : null)

  const refresh = async () => {
    if (!userId) return
    try {
      const local = await readLocalLedger(userId)
      if (local.debts.length || !isDemoEnabled) setDebts(local.debts)
      if (local.repayments.length || !isDemoEnabled) setRepayments(local.repayments)
    } catch { setSyncMessage('本地缓存暂不可用') }
  }

  useEffect(() => {
    void refresh()
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setUser(data.session ? { id: data.session.user.id, email: data.session.user.email ?? null } : null))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setUser(session ? { id: session.user.id, email: session.user.email ?? null } : null))
    return () => listener.subscription.unsubscribe()
  }, [userId])

  useEffect(() => {
    if (!supabase || !user) return
    void syncNow()
  }, [user])

  useEffect(() => {
    const handleOnline = () => { if (supabase && user) void syncNow() }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [user])

  const visibleDebts = useMemo(() => debts.filter((item) => !item.deletedAt), [debts])
  const visibleRepayments = useMemo(() => repayments.filter((item) => !item.deletedAt), [repayments])
  const stats = useMemo(() => calculateStats(debts, repayments), [debts, repayments])

  async function syncNow() {
    if (!supabase || !user) return
    setSyncing(true); setSyncMessage('同步中…')
    const { data } = await supabase.auth.getUser()
    if (data.user) {
      const result = await syncLedger(data.user.id)
      setSyncMessage(result.synced ? (result.pending ? `${result.pending} 条待同步` : '已同步') : result.error ?? '同步失败')
      await refresh()
    }
    setSyncing(false)
  }

  async function saveEditor(item: Debt | Repayment) {
    if (item.id.startsWith('demo-')) return
    if ('person' in item) { await saveDebtOffline(item); setDebts((current) => [...current.filter((row) => row.id !== item.id), item]) }
    else { await saveRepaymentOffline(item); setRepayments((current) => [...current.filter((row) => row.id !== item.id), item]) }
    setEditor(null); setShowActions(false)
    if (supabase && user) void syncNow()
  }

  async function remove(item: Debt | Repayment) {
    if (item.id.startsWith('demo-')) return
    const updatedAt = nowIso()
    await softDeleteOffline('person' in item ? 'debt' : 'repayment', item.id, updatedAt)
    if ('person' in item) setDebts((current) => current.map((row) => row.id === item.id ? { ...row, deletedAt: updatedAt, updatedAt } : row))
    else setRepayments((current) => current.map((row) => row.id === item.id ? { ...row, deletedAt: updatedAt, updatedAt } : row))
    setEditor(null)
    if (supabase && user) void syncNow()
  }

  function openNew(kind: 'debt' | 'repayment') { setShowActions(false); setEditor({ kind }) }
  if (!userId) return <LoginGate />

  return <div className="app-shell">
    <header className="topbar">
      <div><p className="eyebrow">个人账本</p><h1>欠款与还款</h1></div>
      <div className={`sync-pill ${syncing ? 'is-syncing' : ''}`} title={syncMessage}>{supabaseConfigured && user ? <Cloud size={15} /> : <CloudOff size={15} />}<span>{syncMessage}</span></div>
    </header>
    <main className="page-content">
      {tab === 'overview' && <Overview debts={visibleDebts} repayments={visibleRepayments} stats={stats} onEdit={(item) => setEditor({ kind: 'debt', item })} onAddRepayment={(debt) => setEditor({ kind: 'repayment', item: { debtId: debt.id } as Repayment })} />}
      {tab === 'bills' && <Bills debts={visibleDebts} repayments={visibleRepayments} onEdit={(item) => setEditor({ kind: 'repayment', item })} />}
      {tab === 'settings' && <SettingsPanel email={user?.email ?? null} onSignOut={() => setUser(null)} />}
    </main>
    <nav className="bottom-nav" aria-label="主导航">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><CreditCard size={20} /><span>总览</span></button>
      <button className={tab === 'bills' ? 'active' : ''} onClick={() => setTab('bills')}><ReceiptText size={20} /><span>账单</span></button>
      <button className="add-button" aria-label="新增" onClick={() => setShowActions(true)}><Plus size={26} /></button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Settings size={20} /><span>设置</span></button>
    </nav>
    {showActions && <div className="scrim" onClick={() => setShowActions(false)}><div className="action-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><h2>记一笔</h2><button onClick={() => setShowActions(false)} aria-label="关闭"><X size={20} /></button></div><button className="sheet-action" onClick={() => openNew('debt')}><span className="action-icon green"><ArrowUpRight size={20} /></span><span><strong>新增债务</strong><small>记录我欠别人或别人欠我</small></span><ChevronRight size={18} /></button><button className="sheet-action" onClick={() => openNew('repayment')} disabled={!visibleDebts.length}><span className="action-icon blue"><ReceiptText size={20} /></span><span><strong>记还款</strong><small>{visibleDebts.length ? '记录一笔实际还款' : '请先添加债务'}</small></span><ChevronRight size={18} /></button></div></div>}
    {editor && <EditorModal editor={editor} userId={userId} debts={visibleDebts} repayments={visibleRepayments} onSave={saveEditor} onDelete={remove} onClose={() => setEditor(null)} />}
  </div>
}

function Overview({ debts, repayments, stats, onEdit, onAddRepayment }: { debts: Debt[]; repayments: Repayment[]; stats: ReturnType<typeof calculateStats>; onEdit: (debt: Debt) => void; onAddRepayment: (debt: Debt) => void }) {
  return <section>
    <div className="welcome"><p className="eyebrow">今天也理清一笔</p><h2>账目清楚，心里轻松</h2><p>记录每一笔往来，按时收回或还清。</p></div>
    <div className="stat-grid"><StatCard label="待还" amount={stats.oweBalanceCents} tone="green" icon={<ArrowUpRight size={18} />} /><StatCard label="待收" amount={stats.owedBalanceCents} tone="blue" icon={<ArrowDownLeft size={18} />} /></div>
    <div className="month-card"><div><p className="eyebrow">本月已还</p><strong>{formatYuan(stats.monthlyRepaymentCents)}</strong></div><div className="month-icon"><CalendarDays size={22} /></div></div>
    <div className="section-heading"><div><p className="eyebrow">正在进行</p><h2>债务清单</h2></div><span className="muted">{debts.length} 笔</span></div>
    {debts.length ? <div className="debt-list">{debts.map((debt) => <DebtCard key={debt.id} debt={debt} repayments={repayments} onEdit={() => onEdit(debt)} onAddRepayment={() => onAddRepayment(debt)} />)}</div> : <EmptyState title="还没有债务记录" description="从新增债务开始，让每笔往来都有迹可循。" />}
  </section>
}

function StatCard({ label, amount, tone, icon }: { label: string; amount: number; tone: string; icon: React.ReactNode }) { return <div className={`stat-card ${tone}`}><div className="stat-label"><span>{icon}</span>{label}</div><strong>{formatYuan(amount)}</strong><small>人民币余额</small></div> }

function DebtCard({ debt, repayments, onEdit, onAddRepayment }: { debt: Debt; repayments: Repayment[]; onEdit: () => void; onAddRepayment: () => void }) {
  const remaining = remainingCents(debt, repayments); const progress = repaymentProgress(debt, repayments); const done = remaining === 0
  return <article className="debt-card"><div className="debt-card-top"><div className={`direction-mark ${debt.direction}`}><span>{debt.direction === 'owe' ? '还' : '收'}</span></div><div className="debt-main"><div className="person-line"><h3>{debt.person}</h3><span className={`direction-tag ${debt.direction}`}>{debt.direction === 'owe' ? '我欠对方' : '对方欠我'}</span></div><p>{debt.notes || '暂无备注'}</p></div><button className="icon-button" onClick={onEdit} aria-label={`编辑 ${debt.person}`}><Pencil size={17} /></button></div><div className="progress-line"><div><span>{done ? '已结清' : `剩余 ${formatYuan(remaining)}`}</span><span>{Math.round(progress * 100)}%</span></div><div className="progress-track"><div style={{ width: `${progress * 100}%` }} /></div></div><div className="debt-card-bottom"><span>{debt.dueDate ? `到期 ${debt.dueDate.replaceAll('-', '.')}` : '未设置到期日'}</span>{!done && <button className="text-button" onClick={onAddRepayment}>记还款 <ChevronRight size={15} /></button>}</div></article>
}

function Bills({ debts, repayments, onEdit }: { debts: Debt[]; repayments: Repayment[]; onEdit: (item: Repayment) => void }) {
  const debtMap = new Map(debts.map((debt) => [debt.id, debt])); const sorted = [...repayments].sort((a, b) => b.date.localeCompare(a.date))
  return <section><div className="page-heading"><p className="eyebrow">流水记录</p><h2>账单</h2><p>每一笔还款都被好好记录。</p></div>{sorted.length ? <div className="bill-list">{sorted.map((item) => <button className="bill-row" key={item.id} onClick={() => onEdit(item)}><span className="bill-icon"><Check size={17} /></span><span className="bill-info"><strong>{debtMap.get(item.debtId)?.person ?? '已删除债务'}</strong><small>{item.date}{item.notes ? ` · ${item.notes}` : ''}</small></span><strong className="bill-amount">-{formatYuan(item.amountCents)}</strong><ChevronRight size={17} className="muted" /></button>)}</div> : <EmptyState title="暂无还款流水" description="在债务卡片中点击“记还款”，流水会自动出现在这里。" />}</section>
}

function LoginGate() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null); const [submitting, setSubmitting] = useState(false)
  const isSignup = mode === 'signup'

  function switchMode(nextMode: 'login' | 'signup') { setMode(nextMode); setMessage(null); setConfirmPassword('') }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setMessage(null)
    const cleanEmail = email.trim()
    if (isSignup && password !== confirmPassword) { setMessage({ kind: 'error', text: '两次输入的密码不一致。' }); return }
    setSubmitting(true)
    let result
    try { result = isSignup ? await signUpWithPassword(cleanEmail, password) : await signInWithPassword(cleanEmail, password) } catch { setSubmitting(false); setMessage({ kind: 'error', text: '当前无法连接认证服务，请检查网络后重试。' }); return }
    setSubmitting(false)
    if (result.error) { setMessage({ kind: 'error', text: result.error }); return }
    setMessage({ kind: 'success', text: isSignup && result.needsEmailConfirmation ? '注册成功。请打开确认邮件完成邮箱验证，然后返回这里登录；应用不会发送登录链接。' : isSignup ? '注册成功，正在进入账本…' : '登录成功，正在进入账本…' })
  }

  return <main className="auth-gate"><div className="auth-card"><div className="auth-intro"><div className="auth-brand"><div className="auth-mark"><CreditCard size={22} /></div><span>随手记</span></div><p className="eyebrow">个人还账本</p><h1>把每笔往来记清楚</h1><p>记录欠款、还款和到期日，让账目清楚，心里轻松。</p></div>{supabaseConfigured ? <><div className="auth-mode" role="tablist" aria-label="认证方式"><button type="button" role="tab" aria-selected={!isSignup} className={!isSignup ? 'selected' : ''} onClick={() => switchMode('login')}>登录</button><button type="button" role="tab" aria-selected={isSignup} className={isSignup ? 'selected' : ''} onClick={() => switchMode('signup')}>注册</button></div><form className="auth-form" onSubmit={submit}><label htmlFor="auth-email">邮箱地址<input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" required /></label><label htmlFor="auth-password">密码<input id="auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 6 位字符" autoComplete={isSignup ? 'new-password' : 'current-password'} minLength={6} required /></label>{isSignup && <label htmlFor="auth-confirm-password">确认密码<input id="auth-confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入密码" autoComplete="new-password" minLength={6} required /></label>}<button className="primary-button full auth-submit" type="submit" disabled={submitting}>{submitting ? '处理中…' : isSignup ? '创建账号' : '登录账本'}</button>{message && <p className={`${message.kind === 'error' ? 'error-message' : 'form-message'} auth-message`} role="status">{message.text}</p>}</form><p className="auth-note">邮箱+密码登录 · 数据仅同步到你的 Supabase 账号</p></> : <div className="notice-card"><CloudOff size={18} /><div><strong>同步尚未配置</strong><p>请复制 .env.example 为 .env.local，填入 Supabase URL 和 Publishable Key。未配置时不会显示或写入账目。</p></div></div>}</div></main>
}

function SettingsPanel({ email, onSignOut }: { email: string | null; onSignOut: () => void }) {
  return <section><div className="page-heading"><p className="eyebrow">偏好与账户</p><h2>设置</h2><p>管理同步状态和你的使用方式。</p></div><div className="settings-card"><div className="setting-row"><span className="setting-icon"><Cloud size={19} /></span><span><strong>跨设备同步</strong><small>Supabase 安全同步</small></span><span className="status-dot on" /></div><div className="setting-row"><span className="setting-icon"><CreditCard size={19} /></span><span><strong>金额单位</strong><small>人民币（元）· 数据按分存储</small></span><span className="muted">CNY</span></div></div><div className="login-card"><h3>已登录</h3><p>{email ?? '当前账号'}</p><button className="outline-button" onClick={() => { void supabase?.auth.signOut(); onSignOut() }}>退出登录</button></div></section>
}

function EditorModal({ editor, userId, debts, repayments, onSave, onDelete, onClose }: { editor: Exclude<Editor, null>; userId: string; debts: Debt[]; repayments: Repayment[]; onSave: (item: Debt | Repayment) => Promise<void>; onDelete: (item: Debt | Repayment) => Promise<void>; onClose: () => void }) {
  const debt = editor.kind === 'debt' ? editor.item as Debt | undefined : undefined
  const repayment = editor.kind === 'repayment' ? editor.item as Repayment | undefined : undefined
  const [person, setPerson] = useState(debt?.person ?? ''); const [direction, setDirection] = useState<Direction>(debt?.direction ?? 'owe'); const [amount, setAmount] = useState(debt ? formatCents(debt.initialAmountCents) : repayment ? formatCents(repayment.amountCents) : ''); const [dueDate, setDueDate] = useState(debt?.dueDate ?? ''); const [date, setDate] = useState(repayment?.date ?? today()); const [debtId, setDebtId] = useState(repayment?.debtId ?? debts[0]?.id ?? ''); const [notes, setNotes] = useState(debt?.notes ?? repayment?.notes ?? ''); const [error, setError] = useState('')
  const hasExistingRecord = Boolean(debt?.id || repayment?.id)
  async function submit(event: React.FormEvent) { event.preventDefault(); const item = editor.kind === 'debt' ? makeDebt(userId, { person, direction, amount, dueDate, notes }, debt) : makeRepayment(userId, { debtId, amount, date, notes }, repayment); if (!item) { setError(editor.kind === 'debt' ? '请填写对方和正确的金额。' : '请填写债务、金额和日期。'); return } if ('debtId' in item) { const target = debts.find((row) => row.id === item.debtId); const otherRepayments = repayments.filter((row) => row.id !== repayment?.id); if (!target || item.amountCents > remainingCents(target, otherRepayments)) { setError('还款金额不能超过该笔债务的剩余金额。'); return } } await onSave(item) }
  return <div className="scrim" role="presentation"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="editor-title"><div className="sheet-title"><h2 id="editor-title">{hasExistingRecord ? '编辑记录' : editor.kind === 'debt' ? '新增债务' : '记还款'}</h2><button onClick={onClose} aria-label="关闭"><X size={20} /></button></div><form onSubmit={submit}><label>对方<input value={person} onChange={(event) => setPerson(event.target.value)} placeholder="例如：林晓" autoFocus={editor.kind === 'debt'} disabled={editor.kind === 'repayment'} /></label>{editor.kind === 'debt' && <label>方向<div className="segmented"><button type="button" className={direction === 'owe' ? 'selected' : ''} onClick={() => setDirection('owe')}>我欠别人</button><button type="button" className={direction === 'owed' ? 'selected' : ''} onClick={() => setDirection('owed')}>别人欠我</button></div></label>} {editor.kind === 'repayment' && <label>归属债务<select value={debtId} onChange={(event) => setDebtId(event.target.value)}>{debts.map((item) => <option value={item.id} key={item.id}>{item.person} · {formatYuan(remainingCents(item, []))}</option>)}</select></label>}<label>金额（元）<div className="input-prefix"><span>¥</span><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" required /></div></label>{editor.kind === 'debt' ? <label>到期日（可选）<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label> : <label>还款日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>}<label>备注（可选）<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="补充一点说明" rows={2} /></label>{error && <p className="error-message">{error}</p>}<button className="primary-button full" type="submit"><Check size={18} />保存记录</button>{hasExistingRecord && !String((debt || repayment)?.id).startsWith('demo-') && <button className="danger-button full" type="button" onClick={() => void onDelete((debt || repayment)!)}><Trash2 size={17} />删除记录</button>}</form></div></div>
}

function EmptyState({ title, description }: { title: string; description: string }) { return <div className="empty-state"><div className="empty-icon"><ReceiptText size={22} /></div><h3>{title}</h3><p>{description}</p></div> }
