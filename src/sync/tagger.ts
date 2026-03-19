export interface ChunkTags {
  roomTypes: string[];
  designAspects: string[];
}

// Room type keywords — entries with `requires` need a co-occurring keyword from the same group
const ROOM_RULES: { keywords: string[]; tag: string; requires?: string[] }[] = [
  { keywords: ['toilet', 'shower', 'bathtub', 'vanity', 'towel'], tag: 'bathroom' },
  { keywords: ['sink'], tag: 'bathroom', requires: ['toilet', 'shower', 'bathtub', 'vanity', 'towel'] },
  { keywords: ['stove', 'fridge', 'refrigerator', 'oven', 'counter', 'cabinet', 'dishwasher', 'microwave', 'kitchen'], tag: 'kitchen' },
  { keywords: ['bed', 'nightstand', 'wardrobe', 'mattress', 'bedroom'], tag: 'bedroom' },
  { keywords: ['closet'], tag: 'bedroom', requires: ['bed', 'nightstand', 'wardrobe', 'mattress', 'bedroom'] },
  { keywords: ['sofa', 'couch', 'tv', 'coffee table', 'armchair', 'living room', 'lounge'], tag: 'living' },
  { keywords: ['dining table', 'dining room'], tag: 'dining' },
  { keywords: ['chairs'], tag: 'dining', requires: ['dining table', 'dining room'] },
  { keywords: ['hallway', 'corridor', 'foyer', 'entry', 'entryway', 'vestibule'], tag: 'hallway' },
  { keywords: ['office', 'desk', 'study', 'workspace'], tag: 'office' },
  { keywords: ['balcony', 'terrace', 'patio', 'deck', 'outdoor'], tag: 'outdoor' },
];

const ASPECT_RULES: { keywords: string[]; tag: string }[] = [
  { keywords: ['clearance', 'minimum distance', 'spacing', 'gap'], tag: 'clearance' },
  { keywords: ['place', 'position', 'arrange', 'layout', 'locate', 'orient'], tag: 'placement' },
  { keywords: ['triangle', 'workflow', 'flow', 'circulation', 'path', 'walking'], tag: 'workflow' },
  { keywords: ['dimension', 'width', 'depth', 'height', 'size', 'area', 'square'], tag: 'dimensions' },
  { keywords: ['door', 'window', 'swing', 'opening', 'sill', 'arc'], tag: 'openings' },
  { keywords: ['fixture', 'appliance', 'furniture', 'fitting', 'install'], tag: 'fixtures' },
  { keywords: ['material', 'floor', 'wall finish', 'tile', 'wood', 'laminate'], tag: 'materials' },
  { keywords: ['color', 'colour', 'paint', 'tone', 'shade', 'palette'], tag: 'color' },
];

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some(kw => text.includes(kw));
}

/**
 * Tag a chunk with room types and design aspects based on keyword matching.
 * Case-insensitive. A chunk can have multiple tags of each type.
 */
export function tagChunk(heading: string, content: string): ChunkTags {
  const text = `${heading} ${content}`.toLowerCase();

  const roomTypes = new Set<string>();
  for (const rule of ROOM_RULES) {
    if (containsAny(text, rule.keywords)) {
      if (rule.requires) {
        if (containsAny(text, rule.requires)) {
          roomTypes.add(rule.tag);
        }
      } else {
        roomTypes.add(rule.tag);
      }
    }
  }

  const designAspects = new Set<string>();
  for (const rule of ASPECT_RULES) {
    if (containsAny(text, rule.keywords)) {
      designAspects.add(rule.tag);
    }
  }

  return {
    roomTypes: [...roomTypes],
    designAspects: [...designAspects],
  };
}
