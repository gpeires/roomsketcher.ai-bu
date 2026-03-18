import type { RoomType } from './types'

export interface CatalogItem {
  type: string
  label: string
  defaultWidth: number  // cm
  defaultDepth: number  // cm
  roomTypes: RoomType[]
  svgIcon?: string
  catalogId?: string
}

export const FURNITURE_CATALOG: CatalogItem[] = [
  // Bedroom
  { type: 'bed-double', label: 'Bed', defaultWidth: 160, defaultDepth: 200, roomTypes: ['bedroom'] },
  { type: 'bed-single', label: 'Bed', defaultWidth: 90, defaultDepth: 200, roomTypes: ['bedroom'] },
  { type: 'nightstand', label: 'Nightstand', defaultWidth: 50, defaultDepth: 40, roomTypes: ['bedroom'] },
  { type: 'wardrobe', label: 'Wardrobe', defaultWidth: 120, defaultDepth: 60, roomTypes: ['bedroom', 'closet'] },
  { type: 'dresser', label: 'Dresser', defaultWidth: 100, defaultDepth: 50, roomTypes: ['bedroom'] },

  // Living
  { type: 'sofa-3seat', label: 'Sofa', defaultWidth: 220, defaultDepth: 90, roomTypes: ['living'] },
  { type: 'coffee-table', label: 'Coffee Table', defaultWidth: 120, defaultDepth: 60, roomTypes: ['living'] },
  { type: 'tv-unit', label: 'TV Unit', defaultWidth: 150, defaultDepth: 40, roomTypes: ['living'] },
  { type: 'armchair', label: 'Armchair', defaultWidth: 80, defaultDepth: 80, roomTypes: ['living'] },
  { type: 'bookshelf', label: 'Bookshelf', defaultWidth: 80, defaultDepth: 30, roomTypes: ['living', 'office'] },

  // Kitchen
  { type: 'kitchen-counter', label: 'Counter', defaultWidth: 240, defaultDepth: 60, roomTypes: ['kitchen'] },
  { type: 'kitchen-sink', label: 'Sink', defaultWidth: 60, defaultDepth: 60, roomTypes: ['kitchen'] },
  { type: 'fridge', label: 'Fridge', defaultWidth: 70, defaultDepth: 70, roomTypes: ['kitchen'] },
  { type: 'stove', label: 'Stove', defaultWidth: 60, defaultDepth: 60, roomTypes: ['kitchen'] },
  { type: 'dining-table', label: 'Table', defaultWidth: 160, defaultDepth: 90, roomTypes: ['kitchen', 'dining'] },
  { type: 'dining-chair', label: 'Chair', defaultWidth: 45, defaultDepth: 45, roomTypes: ['kitchen', 'dining'] },

  // Bathroom
  { type: 'toilet', label: 'Toilet', defaultWidth: 40, defaultDepth: 65, roomTypes: ['bathroom'] },
  { type: 'bath-sink', label: 'Sink', defaultWidth: 60, defaultDepth: 45, roomTypes: ['bathroom'] },
  { type: 'bathtub', label: 'Bathtub', defaultWidth: 170, defaultDepth: 75, roomTypes: ['bathroom'] },
  { type: 'shower', label: 'Shower', defaultWidth: 90, defaultDepth: 90, roomTypes: ['bathroom'] },

  // Office
  { type: 'desk', label: 'Desk', defaultWidth: 140, defaultDepth: 70, roomTypes: ['office'] },
  { type: 'office-chair', label: 'Chair', defaultWidth: 55, defaultDepth: 55, roomTypes: ['office'] },

  // Dining
  { type: 'sideboard', label: 'Sideboard', defaultWidth: 160, defaultDepth: 45, roomTypes: ['dining'] },

  // Hallway
  { type: 'shoe-rack', label: 'Shoe Rack', defaultWidth: 80, defaultDepth: 30, roomTypes: ['hallway'] },
  { type: 'coat-hook', label: 'Coat Hook', defaultWidth: 60, defaultDepth: 10, roomTypes: ['hallway'] },
]

export function getItemsForRoom(roomType: RoomType): CatalogItem[] {
  return FURNITURE_CATALOG.filter(item => item.roomTypes.includes(roomType))
}
