import { describe, it, expect } from 'vitest';
import { floorPlanToSvg } from './svg';
import type { FloorPlan } from './types';

function makePlan(overrides: Partial<FloorPlan> = {}): FloorPlan {
  return {
    version: 1,
    id: 'test',
    name: 'Test',
    units: 'metric',
    canvas: { width: 1000, height: 800, gridSize: 10 },
    walls: [],
    rooms: [],
    furniture: [],
    annotations: [],
    metadata: { created_at: '', updated_at: '', source: 'ai' },
    ...overrides,
  };
}

describe('floorPlanToSvg', () => {
  it('returns valid SVG string for empty plan', () => {
    const svg = floorPlanToSvg(makePlan());
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('renders walls as lines', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
    }));
    expect(svg).toContain('<line');
    expect(svg).toContain('x1="0"');
    expect(svg).toContain('x2="600"');
  });

  it('renders rooms as polygons with fill', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
      rooms: [
        {
          id: 'r1', label: 'Kitchen', type: 'kitchen',
          polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
          color: '#FFF3E0',
        },
      ],
    }));
    expect(svg).toContain('<polygon');
    expect(svg).toContain('#FFF3E0');
    expect(svg).toContain('Kitchen');
  });

  it('renders door openings as arcs', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        {
          id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior',
          openings: [{ id: 'd1', type: 'door', offset: 100, width: 90, properties: { swingDirection: 'left' } }],
        },
      ],
    }));
    // Door should render an arc path
    expect(svg).toContain('<path');
  });

  it('renders window openings as parallel lines', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        {
          id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior',
          openings: [{ id: 'win1', type: 'window', offset: 200, width: 120, properties: {} }],
        },
      ],
    }));
    expect(svg).toContain('id="openings"');
  });

  it('renders dimension labels along walls', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
    }));
    // 600cm = 6.00m dimension label
    expect(svg).toContain('6.00');
  });

  it('includes watermark', () => {
    const svg = floorPlanToSvg(makePlan());
    expect(svg).toContain('RoomSketcher');
  });

  it('computes viewBox from wall bounding box + padding', () => {
    const svg = floorPlanToSvg(makePlan({
      walls: [
        { id: 'w1', start: { x: 100, y: 100 }, end: { x: 500, y: 100 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
        { id: 'w2', start: { x: 500, y: 100 }, end: { x: 500, y: 400 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
    }));
    // Bounding box: 100,100 → 500,400. With 50cm padding: 50,50 → 550,450
    // viewBox="50 50 500 400"
    expect(svg).toContain('viewBox="50 50 500 400"');
  });

  it('renders furniture as architectural symbols', () => {
    const plan = makePlan({
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
    });
    plan.furniture = [
      { id: 'f1', type: 'bed-double', position: { x: 100, y: 100 }, rotation: 0, width: 160, depth: 200, label: 'Bed' },
    ];
    const svg = floorPlanToSvg(plan);
    expect(svg).toContain('id="furniture"');
    expect(svg).toContain('data-id="f1"');
    expect(svg).toContain('translate(100, 100)');
  });

  it('renders furniture between rooms and walls in z-order', () => {
    const plan = makePlan({
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
    });
    plan.furniture = [
      { id: 'f1', type: 'sofa', position: { x: 100, y: 100 }, rotation: 0, width: 220, depth: 90, label: 'Sofa' },
    ];
    const svg = floorPlanToSvg(plan);
    const roomsIdx = svg.indexOf('id="rooms"');
    const furnitureIdx = svg.indexOf('id="furniture"');
    const wallsIdx = svg.indexOf('id="walls"');
    expect(furnitureIdx).toBeGreaterThan(roomsIdx);
    expect(furnitureIdx).toBeGreaterThan(wallsIdx);
  });

  it('applies rotation transform to furniture', () => {
    const plan = makePlan({
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250, type: 'exterior', openings: [] },
      ],
    });
    plan.furniture = [
      { id: 'f1', type: 'desk', position: { x: 100, y: 100 }, rotation: 90, width: 140, depth: 70, label: 'Desk' },
    ];
    const svg = floorPlanToSvg(plan);
    expect(svg).toContain('rotate(90');
  });
});
