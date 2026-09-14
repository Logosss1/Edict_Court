import { describe, expect, it } from 'vitest'
import { getPipeStatus } from '../../upstream/edict/frontend/src/store.ts'

describe('workflow display does not invent completed stages', () => {
  for (const stage of ['Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Doing', 'Review']) {
    for (const state of ['Blocked', 'Cancelled']) {
      it(`${state} preserves ${stage}`, () => {
        const steps = getPipeStatus({ state, _prev_state: stage })
        expect(steps.find(step => step.status === 'active')?.key).toBe(stage)
      })
    }
  }
  it('unknown legacy stage is not displayed as successful progress', () => {
    expect(getPipeStatus({ state: 'Blocked' }).every(step => step.status === 'pending')).toBe(true)
  })
})
