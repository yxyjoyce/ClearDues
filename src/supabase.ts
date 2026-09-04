import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
const validUrl = Boolean(url && /^https:\/\//.test(url) && !url.includes('YOUR_PROJECT'))
const validKey = Boolean(key && !key.includes('YOUR_') && !key.includes('PLACEHOLDER'))

export const supabaseConfigured = validUrl && validKey
export const isDemoEnabled = import.meta.env.VITE_ENABLE_DEMO === 'true'
export const supabase: SupabaseClient | null = supabaseConfigured ? createClient(url!, key!) : null

export type AuthResult = { error: string | null; needsEmailConfirmation?: boolean }

export function authErrorMessage(message: string): string {
  if (/invalid login credentials/i.test(message)) return '邮箱或密码不正确，请检查后重试。'
  if (/email not confirmed/i.test(message)) return '邮箱还未确认，请先打开确认邮件完成验证。'
  if (/user already registered/i.test(message)) return '这个邮箱已经注册，请切换到“登录”后继续。'
  if (/password.*(6|characters)|weak password/i.test(message)) return '密码至少需要 6 位字符。'
  if (/unable to validate email|invalid email/i.test(message)) return '请输入有效的邮箱地址。'
  return '认证失败，请检查邮箱和密码后重试。'
}

export async function signUpWithPassword(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { error: '尚未配置 Supabase，暂时无法注册。' }
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) return { error: authErrorMessage(error.message) }
  return { error: null, needsEmailConfirmation: Boolean(data.user && !data.session) }
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { error: '尚未配置 Supabase，暂时无法登录。' }
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  return { error: error ? authErrorMessage(error.message) : null }
}
