import type { FloorPlan } from './types';

const TTL_DAYS = 30;

export interface SketchRow {
  id: string;
  plan_json: string;
  svg_cache: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export async function loadSketch(db: D1Database, id: string): Promise<{ plan: FloorPlan; svg: string | null } | null> {
  const row = await db.prepare(
    'SELECT plan_json, svg_cache FROM sketches WHERE id = ?'
  ).bind(id).first<SketchRow>();

  if (!row) return null;
  return {
    plan: JSON.parse(row.plan_json) as FloorPlan,
    svg: row.svg_cache,
  };
}

export async function saveSketch(
  db: D1Database,
  id: string,
  plan: FloorPlan,
  svg: string,
): Promise<void> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await db.prepare(`
    INSERT INTO sketches (id, plan_json, svg_cache, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      plan_json = excluded.plan_json,
      svg_cache = excluded.svg_cache,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `).bind(id, JSON.stringify(plan), svg, now, now, expires).run();
}

export async function cleanupExpiredSketches(db: D1Database): Promise<number> {
  const result = await db.prepare(
    "DELETE FROM sketches WHERE expires_at < datetime('now')"
  ).run();
  return result.meta.changes ?? 0;
}
