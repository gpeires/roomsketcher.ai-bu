import { furnitureDefsBlock } from '../sketch/furniture-symbols';

export function sketcherHtml(sketchId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RoomSketcher AI Sketcher</title>
<link rel="icon" type="image/png" href="https://wpmedia.roomsketcher.com/content/uploads/2021/12/15075948/roomsketcher-logo-square.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Merriweather+Sans:wght@300;400;700&display=swap" rel="stylesheet">
<style>
  :root {
    --rs-teal: #00B5CC;
    --rs-teal-dark: #007B8C;
    --rs-teal-light: #A1DDE5;
    --rs-teal-bg: #F5F9FA;
    --rs-gold: #FEC325;
    --rs-gold-light: #FED87F;
    --rs-dark: #17191A;
    --rs-gray: #5C6566;
    --rs-gray-light: #D5E4E5;
    --rs-danger: #D84200;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Merriweather Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; height: 100vh; display: flex; flex-direction: column; color: var(--rs-dark); }

  /* Header */
  .header { display: flex; align-items: center; padding: 0 16px; height: 52px; background: var(--rs-dark); color: #fff; gap: 12px; flex-shrink: 0; }
  .header img { height: 32px; width: 32px; border-radius: 6px; }
  .header .brand { font-size: 16px; font-weight: 700; letter-spacing: -0.3px; }
  .header .brand span { color: var(--rs-teal-light); font-weight: 300; }
  .header .spacer { flex: 1; }
  .header .status { font-size: 12px; color: var(--rs-teal-light); opacity: 0.8; }

  /* Toolbar */
  .toolbar { display: flex; gap: 4px; padding: 6px 12px; background: #fff; border-bottom: 1px solid var(--rs-gray-light); align-items: center; }
  .toolbar button { padding: 6px 14px; border: 1px solid var(--rs-gray-light); border-radius: 6px; background: #fff; cursor: pointer; font-size: 13px; font-family: inherit; color: var(--rs-dark); transition: all 0.15s; }
  .toolbar button:hover { background: var(--rs-teal-bg); border-color: var(--rs-teal-light); }
  .toolbar button.active { background: var(--rs-teal); color: #fff; border-color: var(--rs-teal-dark); }
  .toolbar .spacer { flex: 1; }
  .toolbar .btn-save { background: var(--rs-dark); color: #fff; border-color: var(--rs-dark); }
  .toolbar .btn-save:hover { background: var(--rs-gray); }
  .toolbar .btn-download { background: var(--rs-gold); color: var(--rs-dark); border-color: var(--rs-gold); font-weight: 700; padding: 6px 18px; }
  .toolbar .btn-download:hover { background: var(--rs-gold-light); }
  .toolbar .btn-download svg { vertical-align: -3px; margin-right: 4px; }

  /* Main area */
  .main { display: flex; flex: 1; overflow: hidden; }

  /* Canvas */
  .canvas-wrap { flex: 1; position: relative; overflow: hidden; background: var(--rs-teal-bg); }
  .canvas-wrap svg { width: 100%; height: 100%; }

  /* Properties panel */
  .props { width: 220px; border-left: 1px solid var(--rs-gray-light); padding: 12px; overflow-y: auto; background: #fff; }
  .props h3 { font-size: 12px; color: var(--rs-teal-dark); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 700; }
  .props label { display: block; font-size: 12px; color: var(--rs-gray); margin-top: 8px; }
  .props input, .props select { width: 100%; padding: 5px 8px; border: 1px solid var(--rs-gray-light); border-radius: 4px; margin-top: 2px; font-size: 13px; font-family: inherit; }
  .props input:focus, .props select:focus { outline: none; border-color: var(--rs-teal); box-shadow: 0 0 0 2px rgba(0,181,204,0.15); }
  .props .none { color: var(--rs-gray); font-size: 12px; font-style: italic; margin-top: 20px; }

  /* Footer CTA */
  .footer { padding: 8px 16px; background: linear-gradient(135deg, var(--rs-teal-bg) 0%, #fff 100%); border-top: 1px solid var(--rs-gray-light); text-align: center; font-size: 13px; color: var(--rs-gray); }
  .footer a { color: var(--rs-teal-dark); text-decoration: none; font-weight: 700; }
  .footer a:hover { text-decoration: underline; color: var(--rs-teal); }

  /* SVG interactive styles */
  svg line[data-id] { cursor: pointer; }
  svg line[data-id]:hover { stroke: var(--rs-teal) !important; }
  svg line.selected { stroke: var(--rs-danger) !important; }
  svg polygon[data-id] { cursor: pointer; }
  svg polygon[data-id]:hover { fill-opacity: 0.7; }

  /* Drawing guide line */
  .guide-line { stroke: var(--rs-teal); stroke-width: 2; stroke-dasharray: 6,4; pointer-events: none; }
  .snap-point { fill: var(--rs-danger); r: 4; pointer-events: none; }
</style>
</head>
<body>
<div class="header">
  <img src="https://wpmedia.roomsketcher.com/content/uploads/2021/12/15075948/roomsketcher-logo-square.png" alt="RoomSketcher">
  <div class="brand">RoomSketcher <span>AI Sketcher</span></div>
  <div class="spacer"></div>
  <span class="status" id="status">Loading...</span>
</div>

<div class="toolbar">
  <button id="btn-select" class="active" title="Select &amp; move (S)">Select</button>
  <button id="btn-wall" title="Draw walls (W)">Wall</button>
  <button id="btn-door" title="Add door to wall">Door</button>
  <button id="btn-window" title="Add window to wall">Window</button>
  <button id="btn-room" title="Label rooms">Room</button>
  <div class="spacer"></div>
  <button id="btn-save" class="btn-save" title="Save to server (\u2318S)">Save</button>
  <button id="btn-download" class="btn-download" title="Download as PDF"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>SVG</button>
</div>

<div class="main">
  <div class="canvas-wrap" id="canvas-wrap">
    <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
    <script>window.__furnitureDefs = ${JSON.stringify(furnitureDefsBlock())};</script>
  </div>
  <div class="props" id="props">
    <h3>Properties</h3>
    <p class="none">Select a wall or room</p>
  </div>
</div>

<div class="footer">
  Powered by <a href="https://roomsketcher.com/signup?utm_source=ai-sketcher&utm_medium=mcp&utm_campaign=sketch-upgrade&utm_content=sketcher-banner" target="_blank">RoomSketcher</a> \u2014 Upgrade for 3D walkthroughs, 7000+ furniture items, and HD renders
</div>

<script>
(function() {
  'use strict';

  const SKETCH_ID = '${sketchId}';
  const API_URL = '/api/sketches/' + SKETCH_ID;
  const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_URL = WS_PROTO + '//' + location.host + '/ws/' + SKETCH_ID;

  // \u2500\u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  let plan = null;
  let tool = 'select'; // select | wall | door | window | room
  let selected = null; // { type: 'wall'|'room', id: string }
  let drawStart = null; // Point for wall drawing
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let viewBox = { x: 0, y: 0, w: 1000, h: 800 };
  let ws = null;

  const svg = document.getElementById('canvas');
  const statusEl = document.getElementById('status');
  const propsEl = document.getElementById('props');

  // \u2500\u2500\u2500 Tool buttons \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const toolButtons = { select: 'btn-select', wall: 'btn-wall', door: 'btn-door', window: 'btn-window', room: 'btn-room' };
  Object.entries(toolButtons).forEach(([t, id]) => {
    document.getElementById(id).addEventListener('click', () => setTool(t));
  });
  document.getElementById('btn-save').addEventListener('click', save);
  document.getElementById('btn-download').addEventListener('click', downloadPdf);

  function setTool(t) {
    tool = t;
    drawStart = null;
    removeGuide();
    Object.entries(toolButtons).forEach(([k, id]) => {
      document.getElementById(id).classList.toggle('active', k === t);
    });
  }

  // \u2500\u2500\u2500 Load plan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  async function load() {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error('Sketch not found');
      const data = await res.json();
      plan = data.plan;
      render();
      statusEl.textContent = 'Loaded';
      connectWs();
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  }

  // \u2500\u2500\u2500 Save \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  async function save() {
    if (!plan) return;
    statusEl.textContent = 'Saving...';
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'save' }));
      } else {
        await fetch(API_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan }),
        });
      }
      statusEl.textContent = 'Saved';
    } catch (e) {
      statusEl.textContent = 'Save failed';
    }
  }

  // \u2500\u2500\u2500 Download PDF \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function downloadPdf() {
    const url = '/api/sketches/' + SKETCH_ID + '/export.pdf';
    const a = document.createElement('a');
    a.href = url;
    a.download = (plan ? plan.name : 'floor-plan') + '.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // \u2500\u2500\u2500 WebSocket \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function connectWs() {
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        statusEl.textContent = 'Connected';
        ws.send(JSON.stringify({ type: 'load', sketch_id: SKETCH_ID }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state_update') {
          plan = msg.plan;
          render();
        } else if (msg.type === 'saved') {
          statusEl.textContent = 'Saved ' + new Date(msg.updated_at).toLocaleTimeString();
        } else if (msg.type === 'error') {
          statusEl.textContent = 'Error: ' + msg.message;
        }
      };
      ws.onclose = () => { statusEl.textContent = 'Disconnected'; };
    } catch (e) {
      // WebSocket not available, REST fallback
    }
  }

  function sendChange(change) {
    if (!plan) return;
    // Apply locally
    applyChangeLocal(change);
    render();
    // Send to server
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(change));
    }
  }

  function applyChangeLocal(change) {
    switch (change.type) {
      case 'add_wall':
        plan.walls.push(change.wall);
        break;
      case 'move_wall': {
        const w = plan.walls.find(w => w.id === change.wall_id);
        if (w) {
          if (change.start) w.start = change.start;
          if (change.end) w.end = change.end;
        }
        break;
      }
      case 'remove_wall':
        plan.walls = plan.walls.filter(w => w.id !== change.wall_id);
        break;
      case 'update_wall': {
        const w = plan.walls.find(w => w.id === change.wall_id);
        if (w) {
          if (change.thickness !== undefined) w.thickness = change.thickness;
          if (change.wall_type !== undefined) w.type = change.wall_type;
        }
        break;
      }
      case 'add_opening': {
        const w = plan.walls.find(w => w.id === change.wall_id);
        if (w) w.openings.push(change.opening);
        break;
      }
      case 'remove_opening': {
        const w = plan.walls.find(w => w.id === change.wall_id);
        if (w) w.openings = w.openings.filter(o => o.id !== change.opening_id);
        break;
      }
      case 'add_room':
        plan.rooms.push(change.room);
        break;
      case 'rename_room': {
        const COLORS = {living:'#E8F5E9',bedroom:'#E3F2FD',kitchen:'#FFF3E0',bathroom:'#E0F7FA',hallway:'#F5F5F5',office:'#F3E5F5',dining:'#FFF8E1',garage:'#EFEBE9',closet:'#ECEFF1',laundry:'#E8EAF6',balcony:'#F1F8E9',terrace:'#F1F8E9',storage:'#ECEFF1',utility:'#ECEFF1',other:'#FAFAFA'};
        const r = plan.rooms.find(r => r.id === change.room_id);
        if (r) {
          r.label = change.label;
          if (change.room_type) { r.type = change.room_type; r.color = COLORS[change.room_type] || '#FAFAFA'; }
        }
        break;
      }
      case 'remove_room':
        plan.rooms = plan.rooms.filter(r => r.id !== change.room_id);
        break;
      case 'add_furniture':
        plan.furniture.push(change.furniture);
        break;
      case 'move_furniture': {
        const f = plan.furniture.find(f => f.id === change.furniture_id);
        if (f) {
          if (change.position) f.position = change.position;
          if (change.rotation !== undefined) f.rotation = change.rotation;
        }
        break;
      }
      case 'remove_furniture':
        plan.furniture = plan.furniture.filter(f => f.id !== change.furniture_id);
        break;
    }
    plan.metadata.updated_at = new Date().toISOString();
    plan.metadata.source = 'mixed';
  }

  // \u2500\u2500\u2500 Render \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function render() {
    if (!plan) return;

    // Compute viewBox from walls
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const w of plan.walls) {
      for (const p of [w.start, w.end]) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (plan.walls.length === 0) {
      minX = 0; minY = 0; maxX = plan.canvas.width; maxY = plan.canvas.height;
    }
    const pad = 80;
    viewBox = { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
    svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);

    let html = window.__furnitureDefs;

    // Grid
    html += '<g id="grid" opacity="0.15">';
    const gs = plan.canvas.gridSize || 10;
    const gStep = gs * 5; // render every 5th grid line for performance
    for (let x = Math.floor(viewBox.x / gStep) * gStep; x <= viewBox.x + viewBox.w; x += gStep) {
      html += '<line x1="' + x + '" y1="' + viewBox.y + '" x2="' + x + '" y2="' + (viewBox.y + viewBox.h) + '" stroke="#ccc" stroke-width="0.5"/>';
    }
    for (let y = Math.floor(viewBox.y / gStep) * gStep; y <= viewBox.y + viewBox.h; y += gStep) {
      html += '<line x1="' + viewBox.x + '" y1="' + y + '" x2="' + (viewBox.x + viewBox.w) + '" y2="' + y + '" stroke="#ccc" stroke-width="0.5"/>';
    }
    html += '</g>';

    // Rooms
    html += '<g id="rooms">';
    for (const room of plan.rooms) {
      const pts = room.polygon.map(p => p.x + ',' + p.y).join(' ');
      const cx = room.polygon.reduce((s, p) => s + p.x, 0) / room.polygon.length;
      const cy = room.polygon.reduce((s, p) => s + p.y, 0) / room.polygon.length;
      const area = computeArea(room.polygon);
      html += '<polygon points="' + pts + '" fill="' + room.color + '" fill-opacity="0.5" stroke="none" data-id="' + room.id + '" data-type="room"/>';
      html += '<text x="' + cx + '" y="' + (cy - 8) + '" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#333">' + escHtml(room.label) + '</text>';
      html += '<text x="' + cx + '" y="' + (cy + 10) + '" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#666">' + area.toFixed(1) + ' m\u00B2</text>';
    }
    html += '</g>';

    // Walls
    html += '<g id="walls">';
    for (const w of plan.walls) {
      const sw = w.type === 'exterior' ? 4 : w.type === 'interior' ? 2 : 1;
      const dash = w.type === 'divider' ? ' stroke-dasharray="6,4"' : '';
      const sel = (selected && selected.type === 'wall' && selected.id === w.id) ? ' class="selected"' : '';
      html += '<line x1="' + w.start.x + '" y1="' + w.start.y + '" x2="' + w.end.x + '" y2="' + w.end.y + '" stroke="#333" stroke-width="' + sw + '" stroke-linecap="round"' + dash + ' data-id="' + w.id + '" data-type="wall"' + sel + '/>';
    }
    html += '</g>';

    // Openings
    html += '<g id="openings">';
    for (const w of plan.walls) {
      const angle = Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      for (const o of w.openings) {
        const ox = w.start.x + cos * o.offset;
        const oy = w.start.y + sin * o.offset;
        const ex = ox + cos * o.width;
        const ey = oy + sin * o.width;
        // Gap
        html += '<line x1="' + ox + '" y1="' + oy + '" x2="' + ex + '" y2="' + ey + '" stroke="white" stroke-width="6"/>';
        if (o.type === 'door') {
          const dir = o.properties.swingDirection === 'right' ? 1 : -1;
          const r = o.width;
          const px = -sin * dir * r, py = cos * dir * r;
          const ax = ox + px, ay = oy + py;
          const sweep = dir === 1 ? 1 : 0;
          html += '<path d="M' + ox + ',' + oy + ' L' + ex + ',' + ey + ' A' + r + ',' + r + ' 0 0,' + sweep + ' ' + ax + ',' + ay + ' Z" fill="none" stroke="#666" stroke-width="1"/>';
        } else if (o.type === 'window') {
          const nx = -sin * 4, ny = cos * 4;
          html += '<line x1="' + (ox+nx) + '" y1="' + (oy+ny) + '" x2="' + (ex+nx) + '" y2="' + (ey+ny) + '" stroke="#4FC3F7" stroke-width="2"/>';
          html += '<line x1="' + (ox-nx) + '" y1="' + (oy-ny) + '" x2="' + (ex-nx) + '" y2="' + (ey-ny) + '" stroke="#4FC3F7" stroke-width="2"/>';
        }
      }
    }
    html += '</g>';

    // Dimensions
    html += '<g id="dimensions">';
    for (const w of plan.walls) {
      const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
      const len = Math.sqrt(dx*dx + dy*dy);
      if (len < 1) continue;
      const label = (len / 100).toFixed(2) + 'm';
      const mx = (w.start.x + w.end.x) / 2, my = (w.start.y + w.end.y) / 2;
      const angle = Math.atan2(dy, dx);
      const lx = mx + Math.cos(angle + Math.PI/2) * 14;
      const ly = my + Math.sin(angle + Math.PI/2) * 14;
      const deg = angle * 180 / Math.PI;
      html += '<text x="' + lx + '" y="' + ly + '" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#999" transform="rotate(' + deg + ',' + lx + ',' + ly + ')">' + label + '</text>';
    }
    html += '</g>';

    // Furniture
    html += '<g id="furniture">';
    for (const item of plan.furniture) {
      const rot = item.rotation || 0;
      const cx = item.position.x + item.width / 2;
      const cy = item.position.y + item.depth / 2;
      const transform = rot ? ' transform="rotate(' + rot + ',' + cx + ',' + cy + ')"' : '';
      const sel = (selected && selected.type === 'furniture' && selected.id === item.id);
      const symbolId = 'fs-' + item.type;
      html += '<g' + transform + ' data-id="' + item.id + '" data-type="furniture">';
      if (sel) {
        html += '<rect x="' + item.position.x + '" y="' + item.position.y + '" width="' + item.width + '" height="' + item.depth + '" fill="none" stroke="#D84200" stroke-width="2"/>';
      }
      html += '<use href="#' + symbolId + '" x="' + item.position.x + '" y="' + item.position.y + '" width="' + item.width + '" height="' + item.depth + '"/>';
      html += '</g>';
    }
    html += '</g>';

    svg.innerHTML = html;
    attachInteraction();
  }

  function computeArea(polygon) {
    let sum = 0;
    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length;
      sum += polygon[i].x * polygon[j].y - polygon[j].x * polygon[i].y;
    }
    return Math.abs(sum) / 2 / 10000; // cm\u00B2 \u2192 m\u00B2
  }

  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // \u2500\u2500\u2500 Interaction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function attachInteraction() {
    // Click on walls/rooms for selection
    svg.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tool === 'select') {
          selected = { type: el.dataset.type, id: el.dataset.id };
          render();
          showProperties();
        } else if (tool === 'door' || tool === 'window') {
          if (el.dataset.type === 'wall') {
            addOpeningToWall(el.dataset.id, tool, e);
          }
        }
      });
    });
  }

  function showProperties() {
    if (!selected || !plan) {
      propsEl.innerHTML = '<h3>Properties</h3><p class="none">Select a wall or room</p>';
      return;
    }

    if (selected.type === 'wall') {
      const wall = plan.walls.find(w => w.id === selected.id);
      if (!wall) return;
      const len = Math.sqrt(Math.pow(wall.end.x - wall.start.x, 2) + Math.pow(wall.end.y - wall.start.y, 2));
      propsEl.innerHTML = '<h3>Wall</h3>' +
        '<label>Type</label><select id="prop-wall-type"><option value="exterior"' + (wall.type==='exterior'?' selected':'') + '>Exterior</option><option value="interior"' + (wall.type==='interior'?' selected':'') + '>Interior</option><option value="divider"' + (wall.type==='divider'?' selected':'') + '>Divider</option></select>' +
        '<label>Thickness (cm)</label><input id="prop-wall-thick" type="number" value="' + wall.thickness + '">' +
        '<label>Length</label><p style="font-size:13px;margin-top:2px">' + (len/100).toFixed(2) + 'm</p>' +
        '<label>Openings</label><p style="font-size:13px;margin-top:2px">' + wall.openings.length + '</p>' +
        '<br><button id="prop-wall-delete" style="color:#D84200;border-color:#D84200;padding:4px 12px;border-radius:4px;background:#fff;cursor:pointer;font-family:inherit">Delete Wall</button>';

      document.getElementById('prop-wall-type').onchange = (e) => {
        sendChange({ type: 'update_wall', wall_id: wall.id, wall_type: e.target.value });
      };
      document.getElementById('prop-wall-thick').onchange = (e) => {
        sendChange({ type: 'update_wall', wall_id: wall.id, thickness: parseInt(e.target.value) });
      };
      document.getElementById('prop-wall-delete').onclick = () => {
        sendChange({ type: 'remove_wall', wall_id: wall.id });
        selected = null;
        showProperties();
      };
    } else if (selected.type === 'room') {
      const room = plan.rooms.find(r => r.id === selected.id);
      if (!room) return;
      const area = computeArea(room.polygon);
      propsEl.innerHTML = '<h3>Room</h3>' +
        '<label>Label</label><input id="prop-room-label" type="text" value="' + escHtml(room.label) + '">' +
        '<label>Type</label><select id="prop-room-type">' +
        ['living','bedroom','kitchen','bathroom','hallway','closet','laundry','office','dining','garage','balcony','terrace','storage','utility','other']
          .map(t => '<option value="' + t + '"' + (room.type===t?' selected':'') + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>').join('') +
        '</select>' +
        '<label>Area</label><p style="font-size:13px;margin-top:2px">' + area.toFixed(1) + ' m\u00B2</p>' +
        '<br><button id="prop-room-delete" style="color:#D84200;border-color:#D84200;padding:4px 12px;border-radius:4px;background:#fff;cursor:pointer;font-family:inherit">Delete Room</button>';

      document.getElementById('prop-room-label').onchange = (e) => {
        sendChange({ type: 'rename_room', room_id: room.id, label: e.target.value });
      };
      document.getElementById('prop-room-type').onchange = (e) => {
        sendChange({ type: 'rename_room', room_id: room.id, label: room.label, room_type: e.target.value });
      };
      document.getElementById('prop-room-delete').onclick = () => {
        sendChange({ type: 'remove_room', room_id: room.id });
        selected = null;
        showProperties();
      };
    }
  }

  // \u2500\u2500\u2500 Wall drawing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function svgPoint(e) {
    const rect = svg.getBoundingClientRect();
    const scaleX = viewBox.w / rect.width;
    const scaleY = viewBox.h / rect.height;
    return {
      x: Math.round((viewBox.x + (e.clientX - rect.left) * scaleX) / 10) * 10,
      y: Math.round((viewBox.y + (e.clientY - rect.top) * scaleY) / 10) * 10,
    };
  }

  function snapToEndpoint(pt) {
    if (!plan) return pt;
    const threshold = 15;
    for (const w of plan.walls) {
      for (const ep of [w.start, w.end]) {
        const d = Math.sqrt(Math.pow(pt.x - ep.x, 2) + Math.pow(pt.y - ep.y, 2));
        if (d < threshold) return { x: ep.x, y: ep.y };
      }
    }
    return pt;
  }

  svg.addEventListener('click', (e) => {
    if (tool !== 'wall') return;
    const pt = snapToEndpoint(svgPoint(e));

    if (!drawStart) {
      drawStart = pt;
    } else {
      const id = 'w' + Date.now().toString(36);
      sendChange({
        type: 'add_wall',
        wall: { id, start: drawStart, end: pt, thickness: 20, height: 250, type: 'exterior', openings: [] },
      });
      drawStart = pt; // chain walls
    }
  });

  svg.addEventListener('mousemove', (e) => {
    if (tool === 'wall' && drawStart) {
      removeGuide();
      const pt = snapToEndpoint(svgPoint(e));
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', drawStart.x);
      line.setAttribute('y1', drawStart.y);
      line.setAttribute('x2', pt.x);
      line.setAttribute('y2', pt.y);
      line.classList.add('guide-line');
      line.id = 'guide';
      svg.appendChild(line);
    }
  });

  function removeGuide() {
    const g = document.getElementById('guide');
    if (g) g.remove();
  }

  // \u2500\u2500\u2500 Opening placement \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function addOpeningToWall(wallId, openingType, event) {
    const wall = plan.walls.find(w => w.id === wallId);
    if (!wall) return;
    const pt = svgPoint(event);
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    const len = Math.sqrt(dx*dx + dy*dy);
    // Project click onto wall to get offset
    const t = ((pt.x - wall.start.x) * dx + (pt.y - wall.start.y) * dy) / (len * len);
    const offset = Math.round(Math.max(0, Math.min(len - 90, t * len)) / 10) * 10;
    const id = (openingType === 'door' ? 'd' : 'win') + Date.now().toString(36);
    const opening = {
      id,
      type: openingType,
      offset,
      width: openingType === 'door' ? 90 : 120,
      properties: openingType === 'door' ? { swingDirection: 'left' } : {},
    };
    sendChange({ type: 'add_opening', wall_id: wallId, opening });
    setTool('select');
  }

  // \u2500\u2500\u2500 Pan & zoom \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const scale = e.deltaY > 0 ? 1.1 : 0.9;
    const rect = svg.getBoundingClientRect();
    const mx = viewBox.x + (e.clientX - rect.left) / rect.width * viewBox.w;
    const my = viewBox.y + (e.clientY - rect.top) / rect.height * viewBox.h;
    viewBox.w *= scale;
    viewBox.h *= scale;
    viewBox.x = mx - (e.clientX - rect.left) / rect.width * viewBox.w;
    viewBox.y = my - (e.clientY - rect.top) / rect.height * viewBox.h;
    svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
  }, { passive: false });

  svg.addEventListener('mousedown', (e) => {
    if (tool === 'select' && e.target === svg) {
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
    }
  });
  svg.addEventListener('mousemove', (e) => {
    if (isPanning) {
      const rect = svg.getBoundingClientRect();
      const dx = (e.clientX - panStart.x) / rect.width * viewBox.w;
      const dy = (e.clientY - panStart.y) / rect.height * viewBox.h;
      viewBox.x -= dx;
      viewBox.y -= dy;
      panStart = { x: e.clientX, y: e.clientY };
      svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
    }
  });
  svg.addEventListener('mouseup', () => { isPanning = false; });

  // \u2500\u2500\u2500 Keyboard shortcuts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setTool('select'); selected = null; render(); showProperties(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected) {
        if (selected.type === 'wall') sendChange({ type: 'remove_wall', wall_id: selected.id });
        if (selected.type === 'room') sendChange({ type: 'remove_room', room_id: selected.id });
        selected = null;
        showProperties();
      }
    }
    if (e.key === 'w') setTool('wall');
    if (e.key === 's' && !e.ctrlKey && !e.metaKey) setTool('select');
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 's') { e.preventDefault(); save(); }
    }
  });

  // \u2500\u2500\u2500 Init \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  load();
})();
</script>
</body>
</html>`;
}
