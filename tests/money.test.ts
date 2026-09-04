import { describe, expect, it } from 'vitest'
import { formatCents, parseAmountToCents } from '../src/money'

describe('money', () => {
  it('converts yuan input to integer cents', () => {
    expect(parseAmountToCents('1.2')).toBe(120)
    expect(parseAmountToCents('1,234.56')).toBe(123456)
    expect(parseAmountToCents('0.009')).toBeNull()
    expect(formatCents(120)).toBe('1.20')
  })
})
