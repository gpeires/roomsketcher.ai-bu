import { describe, it, expect } from 'vitest';
import { compileLayout } from './compile-layout';
import type { SimpleFloorPlanInput } from './types';

describe('compileLayout', () => {
  describe('wall generation', () => {
    it('generates 4 exterior walls for a single room', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Single Room',
        rooms: [{ label: 'Living', x: 0, y: 0, width: 400, depth: 300 }],
      };
      const plan = compileLayout(input);
      const exterior = plan.walls.filter(w => w.type === 'exterior');
      expect(exterior).toHaveLength(4);
      for (const w of exterior) {
        expect(w.thickness).toBe(20);
      }
    });

    it('generates an interior wall between two adjacent rooms', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Two Rooms',
        rooms: [
          { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 300, y: 0, width: 400, depth: 300 },
        ],
      };
      const plan = compileLayout(input);
      const interior = plan.walls.filter(w => w.type === 'interior');
      expect(interior).toHaveLength(1);
      expect(interior[0].thickness).toBe(10);
      expect(interior[0].start).toEqual({ x: 300, y: 0 });
      expect(interior[0].end).toEqual({ x: 300, y: 250 });
    });

    it('generates correct exterior walls for two adjacent rooms', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Two Rooms',
        rooms: [
          { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 300, y: 0, width: 400, depth: 300 },
        ],
      };
      const plan = compileLayout(input);
      const exterior = plan.walls.filter(w => w.type === 'exterior');
      expect(exterior.length).toBeGreaterThanOrEqual(5);
    });

    it('snaps coordinates to 10cm grid', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Snapped',
        rooms: [{ label: 'Room', x: 3, y: 7, width: 303, depth: 248 }],
      };
      const plan = compileLayout(input);
      for (const w of plan.walls) {
        expect(w.start.x % 10).toBe(0);
        expect(w.start.y % 10).toBe(0);
        expect(w.end.x % 10).toBe(0);
        expect(w.end.y % 10).toBe(0);
      }
    });

    it('detects shared edges within snap tolerance', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Near-aligned',
        rooms: [
          { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 305, y: 0, width: 400, depth: 300 },
        ],
      };
      const plan = compileLayout(input);
      const interior = plan.walls.filter(w => w.type === 'interior');
      expect(interior).toHaveLength(1);
    });

    it('handles rooms stacked vertically', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Stacked',
        rooms: [
          { label: 'Bedroom', x: 0, y: 0, width: 400, depth: 300 },
          { label: 'Living', x: 0, y: 300, width: 400, depth: 350 },
        ],
      };
      const plan = compileLayout(input);
      const interior = plan.walls.filter(w => w.type === 'interior');
      expect(interior).toHaveLength(1);
      expect(interior[0].start.y).toBe(300);
      expect(interior[0].end.y).toBe(300);
    });

    it('handles L-shaped layouts (3 rooms, one row shorter)', () => {
      const input: SimpleFloorPlanInput = {
        name: 'L-Shape',
        rooms: [
          { label: 'Bedroom', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 300, y: 0, width: 400, depth: 250 },
          { label: 'Kitchen', x: 300, y: 250, width: 400, depth: 200 },
        ],
      };
      const plan = compileLayout(input);
      const interior = plan.walls.filter(w => w.type === 'interior');
      expect(interior).toHaveLength(2);
      const exterior = plan.walls.filter(w => w.type === 'exterior');
      expect(exterior.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('room polygons', () => {
    it('generates rectangular polygons for rect rooms', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'Room', x: 100, y: 100, width: 300, depth: 200 }],
      };
      const plan = compileLayout(input);
      expect(plan.rooms).toHaveLength(1);
      expect(plan.rooms[0].polygon).toEqual([
        { x: 100, y: 100 },
        { x: 400, y: 100 },
        { x: 400, y: 300 },
        { x: 100, y: 300 },
      ]);
    });

    it('preserves polygon for polygon rooms', () => {
      const poly = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 }, { x: 400, y: 300 }, { x: 400, y: 500 }, { x: 0, y: 500 }];
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'L-Room', polygon: poly }],
      };
      const plan = compileLayout(input);
      expect(plan.rooms[0].polygon).toEqual(poly);
    });

    it('assigns colors by keyword matching on label', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [
          { label: 'Master Bedroom', x: 0, y: 0, width: 400, depth: 300 },
          { label: 'Kitchen', x: 400, y: 0, width: 300, depth: 300 },
          { label: 'Main Bathroom', x: 0, y: 300, width: 300, depth: 200 },
        ],
      };
      const plan = compileLayout(input);
      expect(plan.rooms[0].color).toBe('#E3F2FD');
      expect(plan.rooms[1].color).toBe('#FFF3E0');
      expect(plan.rooms[2].color).toBe('#E0F7FA');
    });

    it('respects explicit color override', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'Room', x: 0, y: 0, width: 300, depth: 200, color: '#FF0000' }],
      };
      const plan = compileLayout(input);
      expect(plan.rooms[0].color).toBe('#FF0000');
    });
  });

  describe('opening placement', () => {
    it('places a door between two rooms on the shared wall', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [
          { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 300, y: 0, width: 400, depth: 300 },
        ],
        openings: [{ type: 'door', between: ['Kitchen', 'Living'] }],
      };
      const plan = compileLayout(input);
      const interior = plan.walls.filter(w => w.type === 'interior');
      expect(interior).toHaveLength(1);
      expect(interior[0].openings).toHaveLength(1);
      expect(interior[0].openings[0].type).toBe('door');
      expect(interior[0].openings[0].width).toBe(80);
    });

    it('places a window on an exterior wall by direction', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'Bedroom', x: 0, y: 0, width: 400, depth: 300 }],
        openings: [{ type: 'window', room: 'Bedroom', wall: 'north' }],
      };
      const plan = compileLayout(input);
      const northWall = plan.walls.find(w =>
        w.type === 'exterior' && w.start.y === 0 && w.end.y === 0
      );
      expect(northWall).toBeDefined();
      expect(northWall!.openings).toHaveLength(1);
      expect(northWall!.openings[0].type).toBe('window');
      expect(northWall!.openings[0].width).toBe(120);
    });

    it('centers openings by default (position=0.5)', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'Room', x: 0, y: 0, width: 400, depth: 300 }],
        openings: [{ type: 'window', room: 'Room', wall: 'north', width: 100 }],
      };
      const plan = compileLayout(input);
      const northWall = plan.walls.find(w =>
        w.type === 'exterior' && w.start.y === 0 && w.end.y === 0
      );
      expect(northWall!.openings[0].offset).toBe(150);
    });

    it('respects custom position along wall', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'Room', x: 0, y: 0, width: 400, depth: 300 }],
        openings: [{ type: 'door', room: 'Room', wall: 'south', position: 0.2 }],
      };
      const plan = compileLayout(input);
      const southWall = plan.walls.find(w =>
        w.type === 'exterior' && w.start.y === 300 && w.end.y === 300
      );
      expect(southWall!.openings).toHaveLength(1);
      expect(southWall!.openings[0].offset).toBe(40);
    });
  });

  describe('furniture placement', () => {
    it('converts room-relative furniture to absolute coordinates', () => {
      const input: SimpleFloorPlanInput = {
        name: 'Test',
        rooms: [{ label: 'Bedroom', x: 200, y: 100, width: 400, depth: 300 }],
        furniture: [{ type: 'bed-double', room: 'Bedroom', x: 20, y: 50, width: 160, depth: 200 }],
      };
      const plan = compileLayout(input);
      expect(plan.furniture).toHaveLength(1);
      expect(plan.furniture[0].position).toEqual({ x: 220, y: 150 });
    });
  });

  describe('full compilation', () => {
    it('compiles a 2BR apartment layout', () => {
      const input: SimpleFloorPlanInput = {
        name: 'NYC 2BR',
        rooms: [
          { label: 'Bedroom', x: 0, y: 0, width: 330, depth: 250 },
          { label: 'Bathroom', x: 330, y: 0, width: 150, depth: 250 },
          { label: 'Primary Bedroom', x: 480, y: 0, width: 320, depth: 270 },
          { label: 'Living & Dining', x: 0, y: 250, width: 500, depth: 360 },
          { label: 'Kitchen', x: 500, y: 250, width: 300, depth: 200 },
          { label: 'Foyer', x: 330, y: 610, width: 260, depth: 160 },
        ],
        openings: [
          { type: 'door', between: ['Bedroom', 'Living & Dining'] },
          { type: 'door', between: ['Primary Bedroom', 'Kitchen'] },
          { type: 'door', between: ['Living & Dining', 'Foyer'] },
          { type: 'window', room: 'Bedroom', wall: 'north' },
          { type: 'window', room: 'Primary Bedroom', wall: 'north' },
          { type: 'window', room: 'Living & Dining', wall: 'west' },
        ],
        furniture: [
          { type: 'bed-double', room: 'Bedroom', x: 20, y: 20, width: 160, depth: 200 },
          { type: 'bed-double', room: 'Primary Bedroom', x: 20, y: 20, width: 160, depth: 200 },
          { type: 'sofa', room: 'Living & Dining', x: 50, y: 50, width: 220, depth: 90 },
        ],
      };
      const plan = compileLayout(input);

      expect(plan.rooms).toHaveLength(6);
      expect(plan.walls.length).toBeGreaterThan(0);
      expect(plan.furniture).toHaveLength(3);

      for (const r of plan.rooms) {
        expect(r.area).toBeGreaterThan(0);
      }

      expect(plan.walls.some(w => w.type === 'interior')).toBe(true);
      expect(plan.walls.some(w => w.type === 'exterior')).toBe(true);

      const wallsWithOpenings = plan.walls.filter(w => w.openings.length > 0);
      expect(wallsWithOpenings.length).toBeGreaterThanOrEqual(6);

      expect(plan.version).toBe(1);
      expect(plan.name).toBe('NYC 2BR');
      expect(plan.units).toBe('metric');
    });

    it('output is compatible with floorPlanToSvg', async () => {
      const { floorPlanToSvg } = await import('./svg');
      const input: SimpleFloorPlanInput = {
        name: 'SVG Test',
        rooms: [
          { label: 'Kitchen', x: 0, y: 0, width: 300, depth: 250 },
          { label: 'Living', x: 300, y: 0, width: 400, depth: 300 },
        ],
        openings: [
          { type: 'door', between: ['Kitchen', 'Living'] },
          { type: 'window', room: 'Kitchen', wall: 'north' },
        ],
      };
      const plan = compileLayout(input);
      const svg = floorPlanToSvg(plan);
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).toContain('id="structure"');
      expect(svg).toContain('id="walls"');
    });
  });
});
