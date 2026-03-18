import { describe, it, expect } from 'vitest'
import { pickCTA, CTA_CONFIG } from './cta-config'
import type { SessionCTAState } from '../types'

function freshState(): SessionCTAState {
  return { ctasShown: 0, lastCtaAt: 0, toolCallCount: 1 }
}

describe('pickCTA', () => {
  it('returns a CTA for a valid trigger', () => {
    const result = pickCTA('first_generation', freshState(), 'default')
    expect(result).not.toBeNull()
    expect(result!.text).toBeTruthy()
    expect(result!.url).toContain('utm_source=ai-sketcher')
  })

  it('returns null when max CTAs reached', () => {
    const state: SessionCTAState = { ctasShown: 10, lastCtaAt: 0, toolCallCount: 20 }
    const result = pickCTA('first_generation', state, 'default')
    expect(result).toBeNull()
  })

  it('returns null during cooldown period', () => {
    const state: SessionCTAState = { ctasShown: 1, lastCtaAt: 5, toolCallCount: 6 }
    const result = pickCTA('first_generation', state, 'default')
    expect(result).toBeNull()
  })

  it('returns null for unknown trigger', () => {
    const result = pickCTA('unknown_trigger', freshState(), 'default')
    expect(result).toBeNull()
  })

  it('filters by variant', () => {
    const result = pickCTA('first_generation', freshState(), 'nonexistent_variant')
    expect(result).toBeNull()
  })
})

describe('CTA_CONFIG', () => {
  it('has triggers for key milestones', () => {
    expect(CTA_CONFIG.triggers['first_generation']).toBeDefined()
    expect(CTA_CONFIG.triggers['export']).toBeDefined()
  })
})
