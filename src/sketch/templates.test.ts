import { describe, it, expect } from 'vitest';
import { FloorPlanSchema } from './types';
import studioTpl from './templates/studio.json';
import onebrTpl from './templates/1br-apartment.json';
import twobrTpl from './templates/2br-apartment.json';
import threebrTpl from './templates/3br-house.json';
import loftTpl from './templates/open-plan-loft.json';
import lshapedTpl from './templates/l-shaped-home.json';

const templates: Record<string, unknown> = {
  'studio': studioTpl,
  '1br-apartment': onebrTpl,
  '2br-apartment': twobrTpl,
  '3br-house': threebrTpl,
  'open-plan-loft': loftTpl,
  'l-shaped-home': lshapedTpl,
};

describe('templates', () => {
  for (const [name, json] of Object.entries(templates)) {
    it(`${name} is a valid FloorPlan`, () => {
      const result = FloorPlanSchema.safeParse(json);
      if (!result.success) {
        console.error(name, result.error.issues);
      }
      expect(result.success).toBe(true);
    });

    it(`${name} has furniture`, () => {
      expect((json as any).furniture.length).toBeGreaterThan(0);
    });
  }
});
