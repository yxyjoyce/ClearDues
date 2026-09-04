import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
const validUrl = Boolean(url && /^https:\/\//.test(url) && !url.includes('YOUR_PROJECT'))
const validKey = Boolean(key && !key.includes('YOUR_') && !key.includes('PLACEHOLDER'))

export const supabaseConfigured = validUrl && validKey
export const isDemoEnabled = import.meta.env.VITE_ENABLE_DEMO === 'true'
export const supabase: SupabaseClient | null = supabaseConfigured ? createClient(url!, key!) : null

export async function sendMagicLink(email: string): Promise<{ error: string | null }> {
  if (!supabase) return { error: '尚未配置 Supabase，无法发送登录链接。' }
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })
  return { error: error?.message ?? null }
}
