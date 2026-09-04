export function parseAmountToCents(value: string): number | null {
  const normalized = value.trim().replace(/,/g, '')
  if (!normalized || !/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [yuan, fen = ''] = normalized.split('.')
  const cents = Number(yuan) * 100 + Number(fen.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

export function formatCents(cents: number): string {
  return (Math.max(0, cents) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function formatYuan(cents: number): string {
  return `¥${formatCents(cents)}`
}
