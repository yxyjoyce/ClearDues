import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from '../src/App'

describe('App shell', () => {
  it('does not expose ledger data before authentication or demo mode', async () => {
    render(<App />)
    expect(await screen.findByText('同步尚未配置')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新增' })).toBeNull()
  })
})
