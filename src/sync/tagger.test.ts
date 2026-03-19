import { describe, it, expect } from 'vitest';
import { tagChunk } from './tagger';

describe('tagChunk', () => {
  it('tags bathroom content', () => {
    const result = tagChunk('Fixture Placement', 'Place the toilet 60cm from the shower and add a vanity.');
    expect(result.roomTypes).toContain('bathroom');
  });

  it('tags kitchen content', () => {
    const result = tagChunk('Kitchen Layout', 'Position the stove, fridge, and dishwasher in a work triangle.');
    expect(result.roomTypes).toContain('kitchen');
    expect(result.designAspects).toContain('workflow');
    expect(result.designAspects).toContain('placement');
  });

  it('requires co-occurrence for "sink"', () => {
    const sinkOnly = tagChunk('Sink', 'The sink is installed under a window.');
    expect(sinkOnly.roomTypes).not.toContain('bathroom');

    const sinkWithToilet = tagChunk('Sink', 'The sink is next to the toilet.');
    expect(sinkWithToilet.roomTypes).toContain('bathroom');
  });

  it('requires co-occurrence for "chairs"', () => {
    const chairsOnly = tagChunk('Seating', 'Arrange the chairs around the room.');
    expect(chairsOnly.roomTypes).not.toContain('dining');

    const chairsWithTable = tagChunk('Dining', 'Arrange the chairs around the dining table.');
    expect(chairsWithTable.roomTypes).toContain('dining');
  });

  it('tags multiple room types', () => {
    const result = tagChunk('Open Plan', 'The sofa faces the TV and the stove is behind the counter.');
    expect(result.roomTypes).toContain('living');
    expect(result.roomTypes).toContain('kitchen');
  });

  it('tags design aspects', () => {
    const result = tagChunk('Spacing', 'Maintain 60cm clearance and minimum distance between fixtures.');
    expect(result.designAspects).toContain('clearance');
    expect(result.designAspects).toContain('fixtures');
  });

  it('returns empty arrays for untaggable content', () => {
    const result = tagChunk('Introduction', 'Welcome to RoomSketcher.');
    expect(result.roomTypes).toEqual([]);
    expect(result.designAspects).toEqual([]);
  });

  it('requires co-occurrence for "closet"', () => {
    const closetOnly = tagChunk('Storage', 'The closet is near the entrance.');
    expect(closetOnly.roomTypes).not.toContain('bedroom');

    const closetWithBed = tagChunk('Storage', 'The closet is next to the bed.');
    expect(closetWithBed.roomTypes).toContain('bedroom');
  });
});
