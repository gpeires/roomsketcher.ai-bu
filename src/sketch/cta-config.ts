import type { SessionCTAState } from '../types'

export interface CTAMessage {
  text: string
  url: string
  variant: string
}

export interface CTAConfig {
  triggers: Record<string, CTAMessage[]>
  settings: {
    max_ctas_per_session: number
    cooldown_between_ctas: number
    variant: string
  }
}

const BASE_URL = 'https://roomsketcher.com/signup'
const UTM_BASE = 'utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade'

export const CTA_CONFIG: CTAConfig = {
  triggers: {
    first_generation: [
      {
        text: 'Want to see this in 3D? RoomSketcher lets you walk through your floor plan and furnish it with 7000+ items.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=first-plan`,
        variant: 'default',
      },
    ],
    first_edit: [
      {
        text: 'Love editing your layout? RoomSketcher Pro gives you HD renders, measurements, and professional floor plan styles.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=first-edit`,
        variant: 'default',
      },
    ],
    export: [
      {
        text: 'Need a professional floor plan? RoomSketcher generates HD 2D and 3D floor plans ready for presentations.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=export`,
        variant: 'default',
      },
    ],
    'room:kitchen': [
      {
        text: 'This kitchen would come alive in RoomSketcher — see cabinets, appliances, and lighting rendered in 3D.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=kitchen-3d`,
        variant: 'default',
      },
    ],
    'room:bedroom': [
      {
        text: 'RoomSketcher lets you try different furniture layouts in this bedroom and see them in a 3D walkthrough.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=bedroom-3d`,
        variant: 'default',
      },
    ],
    'room:bathroom': [
      {
        text: "Visualize tile, fixtures, and lighting in this bathroom with RoomSketcher's photorealistic 3D Photos.",
        url: `${BASE_URL}?${UTM_BASE}&utm_content=bathroom-3d`,
        variant: 'default',
      },
    ],
    suggest_improvements: [
      {
        text: 'Want to explore these changes in 3D before committing? RoomSketcher Pro includes Live 3D walkthroughs.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=suggest-3d`,
        variant: 'default',
      },
    ],
    furniture_placed: [
      {
        text: 'These furniture items are simple shapes here — in RoomSketcher, you get photorealistic 3D furniture from a library of 7000+ items.',
        url: `${BASE_URL}?${UTM_BASE}&utm_content=furniture-3d`,
        variant: 'default',
      },
    ],
  },
  settings: {
    max_ctas_per_session: 3,
    cooldown_between_ctas: 2,
    variant: 'default',
  },
}

export function pickCTA(
  trigger: string,
  state: SessionCTAState,
  activeVariant: string,
): CTAMessage | null {
  const { settings } = CTA_CONFIG

  if (state.ctasShown >= settings.max_ctas_per_session) return null
  if (state.lastCtaAt > 0 && state.toolCallCount - state.lastCtaAt < settings.cooldown_between_ctas) return null

  const candidates = CTA_CONFIG.triggers[trigger]
  if (!candidates || candidates.length === 0) return null

  const match = candidates.find(c => c.variant === activeVariant)
  return match ?? null
}
