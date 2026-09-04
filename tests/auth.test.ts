import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth })),
}))

describe('password authentication', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'public-test-key')
    auth.signInWithPassword.mockReset()
    auth.signUp.mockReset()
  })

  afterEach(() => vi.unstubAllEnvs())

  it('registers with email and password and explains confirmation mode', async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: 'user-1' }, session: null }, error: null })
    const { signUpWithPassword } = await import('../src/supabase')

    await expect(signUpWithPassword('person@example.com', 'secure-pass')).resolves.toEqual({ error: null, needsEmailConfirmation: true })
    expect(auth.signUp).toHaveBeenCalledWith({ email: 'person@example.com', password: 'secure-pass' })
  })

  it('logs in with password without requesting a magic link', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null })
    const { signInWithPassword } = await import('../src/supabase')

    await expect(signInWithPassword('person@example.com', 'secure-pass')).resolves.toEqual({ error: null })
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'person@example.com', password: 'secure-pass' })
  })

  it('turns common Supabase auth errors into clear Chinese feedback', async () => {
    const { authErrorMessage } = await import('../src/supabase')

    expect(authErrorMessage('Invalid login credentials')).toBe('邮箱或密码不正确，请检查后重试。')
    expect(authErrorMessage('Email not confirmed')).toBe('邮箱还未确认，请先打开确认邮件完成验证。')
    expect(authErrorMessage('User already registered')).toBe('这个邮箱已经注册，请切换到“登录”后继续。')
    expect(authErrorMessage('Unexpected auth error')).toBe('认证失败，请检查邮箱和密码后重试。')
  })
})
