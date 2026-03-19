import { furnitureDefsBlock } from '../sketch/furniture-symbols';

export function sketcherHtml(sketchId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
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
.toolbar .btn-download { background: var(--rs-gold); color: var(--rs-dark); border-color: var(--rs-gold); font-weight: 700; padding: 6px 18px; }
  .toolbar .btn-download:hover { background: var(--rs-gold-light); }
  .toolbar .btn-icon { padding: 6px 8px; font-size: 16px; color: var(--rs-gray); }
  .toolbar .btn-icon:disabled { opacity: 0.3; cursor: default; }
  .toolbar .btn-icon:disabled:hover { background: #fff; border-color: var(--rs-gray-light); }
  .toolbar-sep { width: 1px; height: 24px; background: var(--rs-gray-light); margin: 0 4px; }
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
  .drag-handle { cursor: grab; }
  .drag-handle:active { cursor: grabbing; }
  svg polygon[data-id] { cursor: pointer; }
  svg polygon[data-id]:hover { fill-opacity: 0.7; }

  /* Drawing guide line */
  .guide-line { stroke: var(--rs-teal); stroke-width: 2; stroke-dasharray: 6,4; pointer-events: none; }
  .snap-point { fill: var(--rs-danger); r: 4; pointer-events: none; }

  /* Bottom sheet (hidden on desktop) */
  .bottom-sheet { display: none; }

  /* Mobile styles */
  @media (max-width: 768px) {
    .toolbar { display: none; }
    .props { display: none; }
    .footer { display: none; }
    .main { flex: 1; }
    .canvas-wrap { padding-bottom: 100px; }
    .canvas-wrap svg { touch-action: none; }

    .bottom-sheet {
      display: flex;
      flex-direction: column;
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: #fff;
      border-top: 2px solid var(--rs-gray-light);
      border-radius: 12px 12px 0 0;
      transition: transform 0.3s ease;
      z-index: 100;
      padding-bottom: env(safe-area-inset-bottom);
      max-height: 60vh;
      overflow: hidden;
    }
    .bottom-sheet.collapsed { transform: translateY(calc(100% - 100px - env(safe-area-inset-bottom))); }
    .bottom-sheet.expanded { transform: translateY(0); }

    .sheet-handle {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px 0;
      cursor: grab;
    }
    .sheet-handle-bar {
      width: 32px;
      height: 4px;
      background: var(--rs-gray-light);
      border-radius: 2px;
    }

    .sheet-tools {
      display: flex;
      gap: 4px;
      padding: 0 12px 8px;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .sheet-tools button {
      padding: 5px 12px;
      border: 1px solid var(--rs-gray-light);
      border-radius: 6px;
      background: #fff;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      color: var(--rs-dark);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .sheet-tools button.active { background: var(--rs-teal); color: #fff; border-color: var(--rs-teal-dark); }
    .sheet-tools button:disabled { opacity: 0.4; cursor: default; }

    .sheet-props {
      padding: 0 12px 12px;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .sheet-props h3 { font-size: 12px; color: var(--rs-teal-dark); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 700; }
    .sheet-props label { display: block; font-size: 12px; color: var(--rs-gray); margin-top: 8px; }
    .sheet-props input, .sheet-props select { width: 100%; padding: 5px 8px; border: 1px solid var(--rs-gray-light); border-radius: 4px; margin-top: 2px; font-size: 13px; font-family: inherit; }
    .sheet-props .none { color: var(--rs-gray); font-size: 12px; font-style: italic; }

    @media (orientation: landscape) {
      .bottom-sheet { max-height: 50vh; }
    }
  }
</style>
</head>
<body>
<div class="header">
  <a href="/" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit">
    <img src="https://wpmedia.roomsketcher.com/content/uploads/2021/12/15075948/roomsketcher-logo-square.png" alt="RoomSketcher">
    <div class="brand">RoomSketcher <span>AI Sketcher</span></div>
  </a>
  <div class="spacer"></div>
  <span class="status" id="status">Loading...</span>
</div>

<div class="toolbar">
  <button id="btn-select" class="active" title="Select &amp; move (S)">Select</button>
  <button id="btn-wall" title="Draw walls (W)">Wall</button>
  <button id="btn-door" title="Add door to wall (D)">Door</button>
  <button id="btn-window" title="Add window to wall">Window</button>
  <button id="btn-room" title="Label rooms (R)">Room</button>
  <button id="btn-furniture" title="Select furniture (F)">Furniture</button>
  <div class="spacer"></div>
  <button id="btn-undo" class="btn-icon" title="Undo (&#8984;Z)" disabled>&#8630;</button>
  <button id="btn-redo" class="btn-icon" title="Redo (&#8984;&#8679;Z)" disabled>&#8631;</button>
  <div class="toolbar-sep"></div>
  <button id="btn-download" class="btn-download" title="Download SVG"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>SVG</button>
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

<div class="bottom-sheet collapsed" id="bottom-sheet">
  <div class="sheet-handle" id="sheet-handle">
    <div class="sheet-handle-bar"></div>
  </div>
  <div class="sheet-tools" id="sheet-tools"></div>
  <div class="sheet-props" id="sheet-props"></div>
</div>

<script>
(function() {
  'use strict';

  const SKETCH_ID = '${sketchId}';
  const API_URL = '/api/sketches/' + SKETCH_ID;
  const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_URL = WS_PROTO + '//' + location.host + '/ws/' + SKETCH_ID;

  // --- State ---
  var plan = null;
  var tool = 'select';          // active tool: select|wall|door|window|room|furniture
  var interactionMode = 'idle';  // idle|selecting|dragging_endpoint|drawing_wall|panning|placing_opening|rotating_furniture
  var selected = null;           // { type, id }
  var drawStart = null;          // wall drawing start point
  var dragState = null;          // { wallId, endpoint, startPoint, connectedWalls, originalPositions, detached }
  var snapResult = null;         // { point, guides[] }
  var undoStack = [];            // [{ changes[], inverseChanges[] }]
  var redoStack = [];
  var MAX_UNDO = 50;
  var isDragging = false;        // true during endpoint drag (skips full render)
  var viewBox = { x: 0, y: 0, w: 1000, h: 800 };
  var userViewBox = false;
  var ws = null;

  const svg = document.getElementById('canvas');
  const statusEl = document.getElementById('status');
  const propsEl = document.getElementById('props');

  // --- Mobile helpers ---
  const mobileQuery = window.matchMedia('(max-width: 768px)');
  function isMobile() { return mobileQuery.matches; }
  const sheetEl = document.getElementById('bottom-sheet');
  const sheetPropsEl = document.getElementById('sheet-props');
  const sheetToolsEl = document.getElementById('sheet-tools');

  function sheetIsExpanded() { return sheetEl.classList.contains('expanded'); }

  function setSheetState(state) {
    var wasExpanded = sheetIsExpanded();
    sheetEl.classList.toggle('collapsed', state === 'collapsed');
    sheetEl.classList.toggle('expanded', state === 'expanded');
    // When sheet state changes, refit the sketch to visible area
    if (wasExpanded !== sheetIsExpanded()) {
      userViewBox = false;
      render();
    }
  }

  // Sheet handle drag
  (function initSheetDrag() {
    const handle = document.getElementById('sheet-handle');
    let startY = 0, wasExpanded = false;
    handle.addEventListener('touchstart', function(e) {
      startY = e.touches[0].clientY;
      wasExpanded = sheetEl.classList.contains('expanded');
      sheetEl.style.transition = 'none';
    }, { passive: true });
    handle.addEventListener('touchmove', function(e) { e.preventDefault(); }, { passive: false });
    handle.addEventListener('touchend', function(e) {
      sheetEl.style.transition = '';
      var dy = e.changedTouches[0].clientY - startY;
      if (wasExpanded && dy > 40) setSheetState('collapsed');
      else if (!wasExpanded && dy < -40) setSheetState('expanded');
    });
  })();

  // Populate mobile tool buttons
  function updateMobileTools() {
    var tools = [
      { id: 'select', label: 'Select' },
      { id: 'wall', label: 'Wall' },
      { id: 'door', label: 'Door' },
      { id: 'window', label: 'Window' },
      { id: 'room', label: 'Room' },
      { id: 'furniture', label: 'Furniture' },
    ];
    var html = tools.map(function(t) {
      return '<button data-tool="' + t.id + '"' + (t.id === tool ? ' class="active"' : '') + '>' + t.label + '</button>';
    }).join('');
    html += '<div style="width:1px;height:20px;background:var(--rs-gray-light);margin:0 3px;flex-shrink:0"></div>';
    html += '<button id="mobile-undo" style="flex-shrink:0;font-size:14px;padding:4px 7px;border:1px solid var(--rs-gray-light);border-radius:6px;background:#fff;color:var(--rs-gray)" disabled>&#8630;</button>';
    html += '<button id="mobile-redo" style="flex-shrink:0;font-size:14px;padding:4px 7px;border:1px solid var(--rs-gray-light);border-radius:6px;background:#fff;color:var(--rs-gray)" disabled>&#8631;</button>';
    html += '<button id="mobile-download" style="flex-shrink:0;padding:4px 12px;font-size:11px;border:1px solid var(--rs-gold);border-radius:6px;background:var(--rs-gold);color:var(--rs-dark);font-weight:700">&#8595; SVG</button>';
    sheetToolsEl.innerHTML = html;
    sheetToolsEl.querySelectorAll('[data-tool]').forEach(function(btn) {
      btn.addEventListener('click', function() { setTool(btn.dataset.tool); });
    });
    var dlBtn = document.getElementById('mobile-download');
    if (dlBtn) dlBtn.addEventListener('click', function() { downloadPdf(); });
  }
  updateMobileTools();

  // --- Touch gestures (bound once, outside attachInteraction) ---
  (function initTouchHandlers() {
    var touchStart = null;
    var touchStartVB = null;
    var lastPinchDist = 0;
    var isTouchPanning = false;
    var tapStart = null;

    svg.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) {
        var t = e.touches[0];
        touchStart = { x: t.clientX, y: t.clientY };
        touchStartVB = { x: viewBox.x, y: viewBox.y };
        isTouchPanning = false;
        tapStart = { x: t.clientX, y: t.clientY, time: Date.now() };
      } else if (e.touches.length === 2) {
        tapStart = null;
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx * dx + dy * dy);
      }
    }, { passive: true });

    svg.addEventListener('touchmove', function(e) {
      e.preventDefault();
      if (e.touches.length === 1 && touchStart) {
        isTouchPanning = true;
        var t = e.touches[0];
        var rect = svg.getBoundingClientRect();
        var dx = (t.clientX - touchStart.x) / rect.width * viewBox.w;
        var dy = (t.clientY - touchStart.y) / rect.height * viewBox.h;
        viewBox.x = touchStartVB.x - dx;
        viewBox.y = touchStartVB.y - dy;
        userViewBox = true;
        svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
      } else if (e.touches.length === 2) {
        var dx2 = e.touches[0].clientX - e.touches[1].clientX;
        var dy2 = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        if (lastPinchDist > 0) {
          var scale = lastPinchDist / dist;
          var rect = svg.getBoundingClientRect();
          var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          var midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          var mx = viewBox.x + (midX - rect.left) / rect.width * viewBox.w;
          var my = viewBox.y + (midY - rect.top) / rect.height * viewBox.h;
          viewBox.w *= scale;
          viewBox.h *= scale;
          viewBox.x = mx - (midX - rect.left) / rect.width * viewBox.w;
          viewBox.y = my - (midY - rect.top) / rect.height * viewBox.h;
          userViewBox = true;
          svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
        }
        lastPinchDist = dist;
      }
    }, { passive: false });

    svg.addEventListener('touchend', function(e) {
      if (e.touches.length === 0) {
        // Detect tap: short duration, small movement
        if (tapStart && !isTouchPanning) {
          var ct = e.changedTouches[0];
          var dx = ct.clientX - tapStart.x;
          var dy = ct.clientY - tapStart.y;
          var elapsed = Date.now() - tapStart.time;
          if (Math.sqrt(dx * dx + dy * dy) < 10 && elapsed < 300) {
            // Find element under tap point
            var el = document.elementFromPoint(ct.clientX, ct.clientY);
            while (el && !el.dataset.id && el !== svg) el = el.parentElement;
            if (el && el.dataset.id && tool === 'select') {
              selected = { type: el.dataset.type, id: el.dataset.id };
              render();
              showProperties();
            } else {
              // Tapped on empty space — collapse sheet
              if (isMobile()) setSheetState('collapsed');
            }
          }
        }
        touchStart = null;
        touchStartVB = null;
        lastPinchDist = 0;
        isTouchPanning = false;
        tapStart = null;
      }
    }, { passive: true });
  })();

  // --- Tool buttons ---
  var toolButtons = { select: 'btn-select', wall: 'btn-wall', door: 'btn-door', window: 'btn-window', room: 'btn-room', furniture: 'btn-furniture' };
  Object.entries(toolButtons).forEach(function(entry) {
    document.getElementById(entry[1]).addEventListener('click', function() { setTool(entry[0]); });
  });
  document.getElementById('btn-download').addEventListener('click', downloadPdf);

  function setTool(t) {
    tool = t;
    drawStart = null;
    removeGuide();
    Object.entries(toolButtons).forEach(function(entry) {
      document.getElementById(entry[1]).classList.toggle('active', entry[0] === t);
    });
    updateMobileTools();
  }

  // --- Load plan ---
  async function load() {
    try {
      var res = await fetch(API_URL);
      if (!res.ok) throw new Error('Sketch not found');
      var data = await res.json();
      plan = data.plan;
      render();
      statusEl.textContent = 'Loaded';
      connectWs();
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  }

  // --- Save ---
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

  // --- Download PDF ---
  function downloadPdf() {
    var url = '/api/sketches/' + SKETCH_ID + '/export.pdf';
    var a = document.createElement('a');
    a.href = url;
    a.download = (plan ? plan.name : 'floor-plan') + '.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // --- WebSocket ---
  function connectWs() {
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = function() {
        statusEl.textContent = 'Connected';
        ws.send(JSON.stringify({ type: 'load', sketch_id: SKETCH_ID }));
      };
      var wsInitialLoad = true;
      ws.onmessage = function(e) {
        var msg = JSON.parse(e.data);
        if (msg.type === 'state_update') {
          plan = msg.plan;
          // Only auto-fit on first load; subsequent updates preserve user's viewport
          if (wsInitialLoad) { userViewBox = false; wsInitialLoad = false; }
          render();
        } else if (msg.type === 'saved') {
          statusEl.textContent = 'Saved ' + new Date(msg.updated_at).toLocaleTimeString();
        } else if (msg.type === 'error') {
          statusEl.textContent = 'Error: ' + msg.message;
        }
      };
      ws.onclose = function() { statusEl.textContent = 'Disconnected'; };
    } catch (e) {
      // WebSocket not available, REST fallback
    }
  }

  function sendChange(change) {
    if (!plan) return;
    applyChangeLocal(change);
    // Refit so the sketch stays properly positioned (accounting for sheet)
    userViewBox = false;
    render();
    showProperties();
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
        var w = plan.walls.find(function(w) { return w.id === change.wall_id; });
        if (w) {
          if (change.start) w.start = change.start;
          if (change.end) w.end = change.end;
        }
        break;
      }
      case 'remove_wall':
        plan.walls = plan.walls.filter(function(w) { return w.id !== change.wall_id; });
        break;
      case 'update_wall': {
        var w = plan.walls.find(function(w) { return w.id === change.wall_id; });
        if (w) {
          if (change.thickness !== undefined) w.thickness = change.thickness;
          if (change.wall_type !== undefined) w.type = change.wall_type;
        }
        break;
      }
      case 'add_opening': {
        var w = plan.walls.find(function(w) { return w.id === change.wall_id; });
        if (w) w.openings.push(change.opening);
        break;
      }
      case 'remove_opening': {
        var w = plan.walls.find(function(w) { return w.id === change.wall_id; });
        if (w) w.openings = w.openings.filter(function(o) { return o.id !== change.opening_id; });
        break;
      }
      case 'add_room':
        plan.rooms.push(change.room);
        break;
      case 'rename_room': {
        var COLORS = {living:'#E8F5E9',bedroom:'#E3F2FD',kitchen:'#FFF3E0',bathroom:'#E0F7FA',hallway:'#F5F5F5',office:'#F3E5F5',dining:'#FFF8E1',garage:'#EFEBE9',closet:'#ECEFF1',laundry:'#E8EAF6',balcony:'#F1F8E9',terrace:'#F1F8E9',storage:'#ECEFF1',utility:'#ECEFF1',other:'#FAFAFA'};
        var r = plan.rooms.find(function(r) { return r.id === change.room_id; });
        if (r) {
          r.label = change.label;
          if (change.room_type) { r.type = change.room_type; r.color = COLORS[change.room_type] || '#FAFAFA'; }
        }
        break;
      }
      case 'remove_room':
        plan.rooms = plan.rooms.filter(function(r) { return r.id !== change.room_id; });
        break;
      case 'update_room': {
        var r = plan.rooms.find(function(r) { return r.id === change.room_id; });
        if (r) {
          if (change.polygon) { r.polygon = change.polygon; r.area = computeArea(change.polygon); }
          if (change.area !== undefined) r.area = change.area;
        }
        break;
      }
      case 'add_furniture':
        plan.furniture.push(change.furniture);
        break;
      case 'move_furniture': {
        var f = plan.furniture.find(function(f) { return f.id === change.furniture_id; });
        if (f) {
          if (change.position) f.position = change.position;
          if (change.rotation !== undefined) f.rotation = change.rotation;
        }
        break;
      }
      case 'remove_furniture':
        plan.furniture = plan.furniture.filter(function(f) { return f.id !== change.furniture_id; });
        break;
    }
    plan.metadata.updated_at = new Date().toISOString();
    plan.metadata.source = 'mixed';
  }

  // --- Render ---
  function render() {
    if (!plan) return;
    if (isDragging) return;

    // Only recalculate viewBox if user hasn't panned/zoomed
    if (!userViewBox) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < plan.walls.length; i++) {
        var w = plan.walls[i];
        for (var j = 0; j < 2; j++) {
          var p = j === 0 ? w.start : w.end;
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
      if (plan.walls.length === 0) {
        minX = 0; minY = 0; maxX = plan.canvas.width; maxY = plan.canvas.height;
      }
      var pad = 80;
      viewBox = { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };

      // On mobile with expanded sheet, add bottom padding so content fits above the sheet
      if (isMobile() && sheetIsExpanded()) {
        var svgRect = svg.getBoundingClientRect();
        var sheetRect = sheetEl.getBoundingClientRect();
        var sheetOverlap = svgRect.bottom - sheetRect.top;
        if (sheetOverlap > 0 && svgRect.height > 0) {
          var scale = viewBox.h / svgRect.height;
          viewBox.h += sheetOverlap * scale;
        }
      }
    }
    // Top-align on mobile so content stays above sheet; center on desktop
    var par = (isMobile() && sheetIsExpanded()) ? 'xMidYMin meet' : 'xMidYMid meet';
    svg.setAttribute('preserveAspectRatio', par);
    svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);

    var html = window.__furnitureDefs;

    // Grid
    html += '<g id="grid" opacity="0.15">';
    var gs = plan.canvas.gridSize || 10;
    var gStep = gs * 5;
    for (var x = Math.floor(viewBox.x / gStep) * gStep; x <= viewBox.x + viewBox.w; x += gStep) {
      html += '<line x1="' + x + '" y1="' + viewBox.y + '" x2="' + x + '" y2="' + (viewBox.y + viewBox.h) + '" stroke="#ccc" stroke-width="0.5"/>';
    }
    for (var y = Math.floor(viewBox.y / gStep) * gStep; y <= viewBox.y + viewBox.h; y += gStep) {
      html += '<line x1="' + viewBox.x + '" y1="' + y + '" x2="' + (viewBox.x + viewBox.w) + '" y2="' + y + '" stroke="#ccc" stroke-width="0.5"/>';
    }
    html += '</g>';

    // Rooms
    html += '<g id="rooms">';
    for (var ri = 0; ri < plan.rooms.length; ri++) {
      var room = plan.rooms[ri];
      var pts = room.polygon.map(function(p) { return p.x + ',' + p.y; }).join(' ');
      var cx = room.polygon.reduce(function(s, p) { return s + p.x; }, 0) / room.polygon.length;
      var cy = room.polygon.reduce(function(s, p) { return s + p.y; }, 0) / room.polygon.length;
      var area = computeArea(room.polygon);
      html += '<polygon points="' + pts + '" fill="' + room.color + '" fill-opacity="0.5" stroke="none" data-id="' + room.id + '" data-type="room"/>';
      html += '<text x="' + cx + '" y="' + (cy - 8) + '" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#333">' + escHtml(room.label) + '</text>';
      html += '<text x="' + cx + '" y="' + (cy + 10) + '" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#666">' + area.toFixed(1) + ' m\\u00B2</text>';
    }
    html += '</g>';

    // Walls
    html += '<g id="walls">';
    for (var wi = 0; wi < plan.walls.length; wi++) {
      var w = plan.walls[wi];
      var sw = w.type === 'exterior' ? 4 : w.type === 'interior' ? 2 : 1;
      var dash = w.type === 'divider' ? ' stroke-dasharray="6,4"' : '';
      var sel = (selected && selected.type === 'wall' && selected.id === w.id) ? ' class="selected"' : '';
      html += '<line x1="' + w.start.x + '" y1="' + w.start.y + '" x2="' + w.end.x + '" y2="' + w.end.y + '" stroke="#333" stroke-width="' + sw + '" stroke-linecap="round"' + dash + ' data-id="' + w.id + '" data-type="wall"' + sel + '/>';
    }
    html += '</g>';

    // Openings
    html += '<g id="openings">';
    for (var oi = 0; oi < plan.walls.length; oi++) {
      var w = plan.walls[oi];
      var angle = Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x);
      var cos = Math.cos(angle), sin = Math.sin(angle);
      for (var oj = 0; oj < w.openings.length; oj++) {
        var o = w.openings[oj];
        var ox = w.start.x + cos * o.offset;
        var oy = w.start.y + sin * o.offset;
        var ex = ox + cos * o.width;
        var ey = oy + sin * o.width;
        html += '<line x1="' + ox + '" y1="' + oy + '" x2="' + ex + '" y2="' + ey + '" stroke="white" stroke-width="6"/>';
        if (o.type === 'door') {
          var dir = o.properties.swingDirection === 'right' ? 1 : -1;
          var r = o.width;
          var px = -sin * dir * r, py = cos * dir * r;
          var ax = ox + px, ay = oy + py;
          var sweep = dir === 1 ? 1 : 0;
          html += '<path d="M' + ox + ',' + oy + ' L' + ex + ',' + ey + ' A' + r + ',' + r + ' 0 0,' + sweep + ' ' + ax + ',' + ay + ' Z" fill="none" stroke="#666" stroke-width="1"/>';
        } else if (o.type === 'window') {
          var nx = -sin * 4, ny = cos * 4;
          html += '<line x1="' + (ox+nx) + '" y1="' + (oy+ny) + '" x2="' + (ex+nx) + '" y2="' + (ey+ny) + '" stroke="#4FC3F7" stroke-width="2"/>';
          html += '<line x1="' + (ox-nx) + '" y1="' + (oy-ny) + '" x2="' + (ex-nx) + '" y2="' + (ey-ny) + '" stroke="#4FC3F7" stroke-width="2"/>';
        }
      }
    }
    html += '</g>';

    // Dimensions
    html += '<g id="dimensions">';
    for (var di = 0; di < plan.walls.length; di++) {
      var w = plan.walls[di];
      var dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
      var len = Math.sqrt(dx*dx + dy*dy);
      if (len < 1) continue;
      var label = (len / 100).toFixed(2) + 'm';
      var mx = (w.start.x + w.end.x) / 2, my = (w.start.y + w.end.y) / 2;
      var angle = Math.atan2(dy, dx);
      var lx = mx + Math.cos(angle + Math.PI/2) * 14;
      var ly = my + Math.sin(angle + Math.PI/2) * 14;
      var deg = angle * 180 / Math.PI;
      html += '<text x="' + lx + '" y="' + ly + '" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#999" transform="rotate(' + deg + ',' + lx + ',' + ly + ')">' + label + '</text>';
    }
    html += '</g>';

    // Furniture
    html += '<g id="furniture">';
    for (var fi = 0; fi < plan.furniture.length; fi++) {
      var item = plan.furniture[fi];
      var rot = item.rotation || 0;
      var cx = item.position.x + item.width / 2;
      var cy = item.position.y + item.depth / 2;
      var transform = rot ? ' transform="rotate(' + rot + ',' + cx + ',' + cy + ')"' : '';
      var sel = (selected && selected.type === 'furniture' && selected.id === item.id);
      var symbolId = 'fs-' + item.type;
      html += '<g' + transform + ' data-id="' + item.id + '" data-type="furniture">';
      if (sel) {
        html += '<rect x="' + item.position.x + '" y="' + item.position.y + '" width="' + item.width + '" height="' + item.depth + '" fill="none" stroke="#D84200" stroke-width="2"/>';
      }
      html += '<use href="#' + symbolId + '" x="' + item.position.x + '" y="' + item.position.y + '" width="' + item.width + '" height="' + item.depth + '"/>';
      html += '</g>';
    }
    html += '</g>';

    // Drag handles for selected wall
    html += '<g id="drag-handles">';
    if (selected && selected.type === 'wall') {
      var selWall = plan.walls.find(function(w) { return w.id === selected.id; });
      if (selWall) {
        var hr = isMobile() ? 14 : 8;
        html += '<circle class="drag-handle" cx="' + selWall.start.x + '" cy="' + selWall.start.y + '" r="' + hr + '" fill="rgba(0,181,204,0.3)" stroke="#00B5CC" stroke-width="2" data-wall-id="' + selWall.id + '" data-endpoint="start" style="cursor:grab"/>';
        html += '<circle class="drag-handle" cx="' + selWall.end.x + '" cy="' + selWall.end.y + '" r="' + hr + '" fill="rgba(0,181,204,0.3)" stroke="#00B5CC" stroke-width="2" data-wall-id="' + selWall.id + '" data-endpoint="end" style="cursor:grab"/>';
      }
    }
    html += '</g>';
    // Snap guides overlay (populated during drag by renderSnapGuides)
    html += '<g id="snap-guides"></g>';

    svg.innerHTML = html;
    attachInteraction();
  }

  function computeArea(polygon) {
    var sum = 0;
    for (var i = 0; i < polygon.length; i++) {
      var j = (i + 1) % polygon.length;
      sum += polygon[i].x * polygon[j].y - polygon[j].x * polygon[i].y;
    }
    return Math.abs(sum) / 2 / 10000;
  }

  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // --- Interaction ---
  function attachInteraction() {
    // Interaction now handled by state machine mousedown/mousemove/mouseup on svg
  }

  // --- Properties rendering ---
  function renderPropertiesHtml() {
    if (!selected || !plan) {
      return '<h3>Properties</h3><p class="none">Select a wall or room</p>';
    }

    if (selected.type === 'wall') {
      var wall = plan.walls.find(function(w) { return w.id === selected.id; });
      if (!wall) return '';
      var dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      var angle = Math.atan2(dy, dx) * 180 / Math.PI;
      return '<h3>Wall</h3>' +
        '<label>Type</label><select id="prop-wall-type"><option value="exterior"' + (wall.type==='exterior'?' selected':'') + '>Exterior</option><option value="interior"' + (wall.type==='interior'?' selected':'') + '>Interior</option><option value="divider"' + (wall.type==='divider'?' selected':'') + '>Divider</option></select>' +
        '<label>Thickness (cm)</label><input id="prop-wall-thick" type="number" value="' + wall.thickness + '">' +
        '<label>Length (m)</label><input id="prop-wall-length" type="number" step="0.01" value="' + (len / 100).toFixed(2) + '">' +
        '<label>Angle (&deg;)</label><input id="prop-wall-angle" type="number" step="1" value="' + Math.round(angle) + '">' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px">' +
        '<div><label>Start X</label><input id="prop-wall-sx" type="number" value="' + Math.round(wall.start.x) + '"></div>' +
        '<div><label>Start Y</label><input id="prop-wall-sy" type="number" value="' + Math.round(wall.start.y) + '"></div>' +
        '<div><label>End X</label><input id="prop-wall-ex" type="number" value="' + Math.round(wall.end.x) + '"></div>' +
        '<div><label>End Y</label><input id="prop-wall-ey" type="number" value="' + Math.round(wall.end.y) + '"></div>' +
        '</div>' +
        '<label>Openings (' + wall.openings.length + ')</label>' +
        wall.openings.map(function(o) {
          return '<div style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:12px">' +
            '<span>' + o.type + ' (' + o.width + 'cm)</span>' +
            '<button data-remove-opening="' + o.id + '" style="color:#D84200;border:1px solid #D84200;border-radius:3px;background:#fff;cursor:pointer;font-size:11px;padding:1px 6px">&times;</button>' +
            '</div>';
        }).join('') +
        '<br><button id="prop-wall-delete" style="color:#D84200;border:1px solid #D84200;padding:4px 12px;border-radius:4px;background:#fff;cursor:pointer;font-family:inherit">Delete Wall</button>';
    } else if (selected.type === 'room') {
      var room = plan.rooms.find(function(r) { return r.id === selected.id; });
      if (!room) return '';
      var area = computeArea(room.polygon);
      return '<h3>Room</h3>' +
        '<label>Label</label><input id="prop-room-label" type="text" value="' + escHtml(room.label) + '">' +
        '<label>Type</label><select id="prop-room-type">' +
        ['living','bedroom','kitchen','bathroom','hallway','closet','laundry','office','dining','garage','balcony','terrace','storage','utility','other']
          .map(function(t) { return '<option value="' + t + '"' + (room.type===t?' selected':'') + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('') +
        '</select>' +
        '<label>Area</label><p style="font-size:13px;margin-top:2px">' + area.toFixed(1) + ' m\\u00B2</p>' +
        '<br><button id="prop-room-delete" style="color:#D84200;border-color:#D84200;padding:4px 12px;border-radius:4px;background:#fff;cursor:pointer;font-family:inherit">Delete Room</button>';
    } else if (selected.type === 'furniture') {
      var item = plan.furniture.find(function(f) { return f.id === selected.id; });
      if (!item) return '';
      return '<h3>Furniture</h3>' +
        '<label>Type</label><p style="font-size:13px;margin-top:2px">' + escHtml(item.type) + '</p>' +
        '<label>Size</label><p style="font-size:13px;margin-top:2px">' + item.width + ' &times; ' + item.depth + ' cm</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px">' +
        '<div><label>Position X</label><input id="prop-furn-x" type="number" value="' + Math.round(item.position.x) + '"></div>' +
        '<div><label>Position Y</label><input id="prop-furn-y" type="number" value="' + Math.round(item.position.y) + '"></div>' +
        '</div>' +
        '<label>Rotation (&deg;)</label><input id="prop-furn-rot" type="number" step="15" value="' + (item.rotation || 0) + '">' +
        '<br><button id="prop-furn-delete" style="color:#D84200;border:1px solid #D84200;padding:4px 12px;border-radius:4px;background:#fff;cursor:pointer;font-family:inherit">Delete</button>';
    }
    return '';
  }

  function attachPropertiesHandlers() {
    if (!selected || !plan) return;

    if (selected.type === 'wall') {
      var wall = plan.walls.find(function(w) { return w.id === selected.id; });
      if (!wall) return;
      var typeEl = document.getElementById('prop-wall-type');
      var thickEl = document.getElementById('prop-wall-thick');
      var delEl = document.getElementById('prop-wall-delete');
      if (typeEl) typeEl.onchange = function(e) {
        sendChange({ type: 'update_wall', wall_id: wall.id, wall_type: e.target.value });
      };
      if (thickEl) thickEl.onchange = function(e) {
        sendChange({ type: 'update_wall', wall_id: wall.id, thickness: parseInt(e.target.value) });
      };
      if (delEl) delEl.onclick = function() {
        sendChange({ type: 'remove_wall', wall_id: wall.id });
        selected = null;
        showProperties();
      };
      // Length change: preserve start point and angle, adjust end point
      var lenEl = document.getElementById('prop-wall-length');
      if (lenEl) lenEl.onchange = function(e) {
        var newLen = parseFloat(e.target.value) * 100;
        if (isNaN(newLen) || newLen < 1) return;
        var dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
        var curLen = Math.sqrt(dx * dx + dy * dy);
        if (curLen < 0.01) return;
        var scale = newLen / curLen;
        sendChange({ type: 'move_wall', wall_id: wall.id, end: { x: Math.round(wall.start.x + dx * scale), y: Math.round(wall.start.y + dy * scale) } });
      };
      // Angle change: preserve start point and length, rotate end point
      var angEl = document.getElementById('prop-wall-angle');
      if (angEl) angEl.onchange = function(e) {
        var newAngle = parseFloat(e.target.value) * Math.PI / 180;
        if (isNaN(newAngle)) return;
        var dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        sendChange({ type: 'move_wall', wall_id: wall.id, end: { x: Math.round(wall.start.x + Math.cos(newAngle) * len), y: Math.round(wall.start.y + Math.sin(newAngle) * len) } });
      };
      // Coordinate changes (commit on blur/enter via onchange)
      ['prop-wall-sx', 'prop-wall-sy', 'prop-wall-ex', 'prop-wall-ey'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.onchange = function() {
          var sx = parseInt(document.getElementById('prop-wall-sx').value);
          var sy = parseInt(document.getElementById('prop-wall-sy').value);
          var ex = parseInt(document.getElementById('prop-wall-ex').value);
          var ey = parseInt(document.getElementById('prop-wall-ey').value);
          if ([sx, sy, ex, ey].some(isNaN)) return;
          sendChange({ type: 'move_wall', wall_id: wall.id, start: { x: sx, y: sy }, end: { x: ex, y: ey } });
        };
      });
      // Opening delete buttons
      document.querySelectorAll('[data-remove-opening]').forEach(function(btn) {
        btn.onclick = function() {
          sendChange({ type: 'remove_opening', wall_id: wall.id, opening_id: btn.dataset.removeOpening });
        };
      });
    } else if (selected.type === 'room') {
      var room = plan.rooms.find(function(r) { return r.id === selected.id; });
      if (!room) return;
      var labelEl = document.getElementById('prop-room-label');
      var typeEl = document.getElementById('prop-room-type');
      var delEl = document.getElementById('prop-room-delete');
      if (labelEl) labelEl.onchange = function(e) {
        sendChange({ type: 'rename_room', room_id: room.id, label: e.target.value });
      };
      if (typeEl) typeEl.onchange = function(e) {
        sendChange({ type: 'rename_room', room_id: room.id, label: room.label, room_type: e.target.value });
      };
      if (delEl) delEl.onclick = function() {
        sendChange({ type: 'remove_room', room_id: room.id });
        selected = null;
        showProperties();
      };
    } else if (selected.type === 'furniture') {
      var item = plan.furniture.find(function(f) { return f.id === selected.id; });
      if (!item) return;
      var delEl = document.getElementById('prop-furn-delete');
      if (delEl) delEl.onclick = function() {
        sendChange({ type: 'remove_furniture', furniture_id: selected.id });
        selected = null;
        showProperties();
      };
      var fxEl = document.getElementById('prop-furn-x');
      var fyEl = document.getElementById('prop-furn-y');
      var frotEl = document.getElementById('prop-furn-rot');
      if (fxEl) fxEl.onchange = function(e) {
        sendChange({ type: 'move_furniture', furniture_id: item.id, position: { x: parseInt(e.target.value), y: item.position.y } });
      };
      if (fyEl) fyEl.onchange = function(e) {
        sendChange({ type: 'move_furniture', furniture_id: item.id, position: { x: item.position.x, y: parseInt(e.target.value) } });
      };
      if (frotEl) frotEl.onchange = function(e) {
        sendChange({ type: 'move_furniture', furniture_id: item.id, rotation: parseInt(e.target.value) });
      };
    }
  }

  function showProperties() {
    var html = renderPropertiesHtml();
    if (isMobile()) {
      sheetPropsEl.innerHTML = html;
      attachPropertiesHandlers();
      if (selected) setSheetState('expanded');
    } else {
      propsEl.innerHTML = html;
      attachPropertiesHandlers();
    }
  }

  // --- Wall drawing ---
  function svgPoint(e) {
    var rect = svg.getBoundingClientRect();
    var scaleX = viewBox.w / rect.width;
    var scaleY = viewBox.h / rect.height;
    return {
      x: Math.round((viewBox.x + (e.clientX - rect.left) * scaleX) / 10) * 10,
      y: Math.round((viewBox.y + (e.clientY - rect.top) * scaleY) / 10) * 10,
    };
  }

  function svgPointRaw(e) {
    var rect = svg.getBoundingClientRect();
    var scaleX = viewBox.w / rect.width;
    var scaleY = viewBox.h / rect.height;
    return {
      x: viewBox.x + (e.clientX - rect.left) * scaleX,
      y: viewBox.y + (e.clientY - rect.top) * scaleY,
    };
  }

  function snapToEndpoint(pt) {
    if (!plan) return pt;
    var threshold = 15;
    for (var i = 0; i < plan.walls.length; i++) {
      var w = plan.walls[i];
      var endpoints = [w.start, w.end];
      for (var j = 0; j < endpoints.length; j++) {
        var ep = endpoints[j];
        var d = Math.sqrt(Math.pow(pt.x - ep.x, 2) + Math.pow(pt.y - ep.y, 2));
        if (d < threshold) return { x: ep.x, y: ep.y };
      }
    }
    return pt;
  }

  svg.addEventListener('click', function(e) {
    if (tool !== 'wall') return;
    var pt = snapToEndpoint(svgPoint(e));

    if (!drawStart) {
      drawStart = pt;
    } else {
      var id = 'w' + Date.now().toString(36);
      sendChange({
        type: 'add_wall',
        wall: { id: id, start: drawStart, end: pt, thickness: 20, height: 250, type: 'exterior', openings: [] },
      });
      drawStart = pt;
    }
  });

  function removeGuide() {
    var g = document.getElementById('guide');
    if (g) g.remove();
  }

  // --- Opening placement ---
  function addOpeningToWall(wallId, openingType, event) {
    var wall = plan.walls.find(function(w) { return w.id === wallId; });
    if (!wall) return;
    var pt = svgPoint(event);
    var dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
    var len = Math.sqrt(dx*dx + dy*dy);
    var t = ((pt.x - wall.start.x) * dx + (pt.y - wall.start.y) * dy) / (len * len);
    var offset = Math.round(Math.max(0, Math.min(len - 90, t * len)) / 10) * 10;
    var id = (openingType === 'door' ? 'd' : 'win') + Date.now().toString(36);
    var opening = {
      id: id,
      type: openingType,
      offset: offset,
      width: openingType === 'door' ? 90 : 120,
      properties: openingType === 'door' ? { swingDirection: 'left' } : {},
    };
    sendChange({ type: 'add_opening', wall_id: wallId, opening: opening });
    setTool('select');
  }

  // --- Pan & zoom (mouse) ---
  svg.addEventListener('wheel', function(e) {
    e.preventDefault();
    var scale = e.deltaY > 0 ? 1.1 : 0.9;
    var rect = svg.getBoundingClientRect();
    var mx = viewBox.x + (e.clientX - rect.left) / rect.width * viewBox.w;
    var my = viewBox.y + (e.clientY - rect.top) / rect.height * viewBox.h;
    viewBox.w *= scale;
    viewBox.h *= scale;
    viewBox.x = mx - (e.clientX - rect.left) / rect.width * viewBox.w;
    viewBox.y = my - (e.clientY - rect.top) / rect.height * viewBox.h;
    userViewBox = true;
    svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
  }, { passive: false });

  // --- Desktop mouse interaction (state machine) ---
  var panStart = { x: 0, y: 0 };
  var mouseDownTarget = null;
  var mouseDownPoint = null;

  svg.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    mouseDownPoint = { x: e.clientX, y: e.clientY };

    if (tool === 'wall') {
      // Wall drawing is click-click, handled in the existing click event
      return;
    }

    // Check if we clicked on a drag handle (added in Task 4)
    var el = e.target;
    if (el.classList && el.classList.contains('drag-handle')) {
      interactionMode = 'selecting';
      mouseDownTarget = { type: 'handle', wallId: el.dataset.wallId, endpoint: el.dataset.endpoint };
      return;
    }

    // Check for rotation handle (added in Task 11)
    if (el.classList && el.classList.contains('rotation-handle')) {
      interactionMode = 'rotating_furniture';
      var furn = plan ? plan.furniture.find(function(f) { return f.id === el.dataset.furnitureId; }) : null;
      mouseDownTarget = { type: 'rotation', furnitureId: el.dataset.furnitureId, originalRotation: furn ? (furn.rotation || 0) : 0 };
      return;
    }

    // Check if we clicked on a data element (wall, room, furniture)
    while (el && !el.dataset.id && el !== svg) el = el.parentElement;
    if (el && el.dataset.id) {
      mouseDownTarget = { type: el.dataset.type, id: el.dataset.id };
      interactionMode = 'selecting';
      return;
    }

    // Empty canvas — start panning (works in ALL tool modes)
    interactionMode = 'panning';
    panStart = { x: e.clientX, y: e.clientY };
  });

  svg.addEventListener('mousemove', function(e) {
    // Wall drawing guide line
    if (tool === 'wall' && drawStart) {
      removeGuide();
      var pt = snapToEndpoint(svgPoint(e));
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', drawStart.x);
      line.setAttribute('y1', drawStart.y);
      line.setAttribute('x2', pt.x);
      line.setAttribute('y2', pt.y);
      line.classList.add('guide-line');
      line.id = 'guide';
      svg.appendChild(line);
    }

    // Click vs drag detection (3px threshold)
    if (interactionMode === 'selecting' && mouseDownPoint) {
      var dx = e.clientX - mouseDownPoint.x;
      var dy = e.clientY - mouseDownPoint.y;
      if (Math.sqrt(dx * dx + dy * dy) > 3) {
        if (mouseDownTarget && mouseDownTarget.type === 'handle') {
          interactionMode = 'dragging_endpoint';
          beginEndpointDrag(mouseDownTarget.wallId, mouseDownTarget.endpoint);
          // Alt/Option key = detach mode (don't move connected walls)
          if (e.altKey && dragState) dragState.detached = true;
        } else {
          // Not on a handle — fall through to panning
          interactionMode = 'panning';
          panStart = { x: e.clientX, y: e.clientY };
        }
      }
    }

    if (interactionMode === 'dragging_endpoint') {
      updateEndpointDrag(e);
    }

    if (interactionMode === 'rotating_furniture' && mouseDownTarget) {
      updateFurnitureRotation(e);
    }

    if (interactionMode === 'panning') {
      var rect = svg.getBoundingClientRect();
      var ddx = (e.clientX - panStart.x) / rect.width * viewBox.w;
      var ddy = (e.clientY - panStart.y) / rect.height * viewBox.h;
      viewBox.x -= ddx;
      viewBox.y -= ddy;
      panStart = { x: e.clientX, y: e.clientY };
      userViewBox = true;
      svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
    }
  });

  svg.addEventListener('mouseup', function(e) {
    if (interactionMode === 'selecting') {
      // Was a click (< 3px movement)
      if (mouseDownTarget && mouseDownTarget.type !== 'handle') {
        if (tool === 'select' || tool === 'furniture') {
          selected = { type: mouseDownTarget.type, id: mouseDownTarget.id };
          render();
          showProperties();
        } else if ((tool === 'door' || tool === 'window') && mouseDownTarget.type === 'wall') {
          addOpeningToWall(mouseDownTarget.id, tool, e);
        }
      }
    }

    if (interactionMode === 'dragging_endpoint') {
      commitEndpointDrag();
    }

    if (interactionMode === 'rotating_furniture' && mouseDownTarget) {
      commitFurnitureRotation();
    }

    // If we were panning but barely moved, treat as deselect click
    if (interactionMode === 'panning' && mouseDownPoint) {
      var pdx = e.clientX - mouseDownPoint.x;
      var pdy = e.clientY - mouseDownPoint.y;
      if (Math.sqrt(pdx * pdx + pdy * pdy) < 3) {
        selected = null;
        render();
        showProperties();
      }
    }

    interactionMode = 'idle';
    mouseDownTarget = null;
    mouseDownPoint = null;
  });

  function findConnectedEndpoints(wallId, endpoint) {
    var wall = plan.walls.find(function(w) { return w.id === wallId; });
    if (!wall) return [];
    var pt = endpoint === 'start' ? wall.start : wall.end;
    var threshold = 1; // 1cm
    var connected = [];
    for (var i = 0; i < plan.walls.length; i++) {
      var w = plan.walls[i];
      if (w.id === wallId) continue;
      if (Math.abs(w.start.x - pt.x) <= threshold && Math.abs(w.start.y - pt.y) <= threshold) {
        connected.push({ wallId: w.id, endpoint: 'start' });
      }
      if (Math.abs(w.end.x - pt.x) <= threshold && Math.abs(w.end.y - pt.y) <= threshold) {
        connected.push({ wallId: w.id, endpoint: 'end' });
      }
    }
    return connected;
  }

  function beginEndpointDrag(wallId, endpoint) {
    var wall = plan.walls.find(function(w) { return w.id === wallId; });
    if (!wall) return;
    var startPoint = endpoint === 'start' ? wall.start : wall.end;
    dragState = {
      wallId: wallId,
      endpoint: endpoint,
      startPoint: { x: startPoint.x, y: startPoint.y },
      connectedWalls: findConnectedEndpoints(wallId, endpoint),
      originalPositions: {},
      detached: false
    };
    dragState.originalPositions[wallId] = {
      start: { x: wall.start.x, y: wall.start.y },
      end: { x: wall.end.x, y: wall.end.y }
    };
    var connected = dragState.connectedWalls;
    for (var i = 0; i < connected.length; i++) {
      var cw = plan.walls.find(function(w) { return w.id === connected[i].wallId; });
      if (cw) {
        dragState.originalPositions[connected[i].wallId] = {
          start: { x: cw.start.x, y: cw.start.y },
          end: { x: cw.end.x, y: cw.end.y }
        };
      }
    }
    isDragging = true;
  }

  function updateEndpointDrag(e) {
    if (!dragState || !plan) return;
    var rawPt = svgPointRaw(e);
    // Grid snap (10cm) — full snap system replaces this in Task 7
    var pt = { x: Math.round(rawPt.x / 10) * 10, y: Math.round(rawPt.y / 10) * 10 };

    var wall = plan.walls.find(function(w) { return w.id === dragState.wallId; });
    if (!wall) return;

    // Update model
    if (dragState.endpoint === 'start') wall.start = pt;
    else wall.end = pt;

    // Direct DOM update (no full render — performance)
    var wallEl = svg.querySelector('line[data-id="' + dragState.wallId + '"]');
    if (wallEl) {
      wallEl.setAttribute('x1', wall.start.x);
      wallEl.setAttribute('y1', wall.start.y);
      wallEl.setAttribute('x2', wall.end.x);
      wallEl.setAttribute('y2', wall.end.y);
    }

    // Update drag handle positions
    svg.querySelectorAll('.drag-handle[data-wall-id="' + dragState.wallId + '"]').forEach(function(h) {
      var ep = h.dataset.endpoint === 'start' ? wall.start : wall.end;
      h.setAttribute('cx', ep.x);
      h.setAttribute('cy', ep.y);
    });

    // Move connected walls (unless Alt/Option = detach mode)
    if (!dragState.detached && dragState.connectedWalls) {
      for (var i = 0; i < dragState.connectedWalls.length; i++) {
        var conn = dragState.connectedWalls[i];
        var cw = plan.walls.find(function(w) { return w.id === conn.wallId; });
        if (!cw) continue;
        if (conn.endpoint === 'start') cw.start = { x: pt.x, y: pt.y };
        else cw.end = { x: pt.x, y: pt.y };

        var cwEl = svg.querySelector('line[data-id="' + conn.wallId + '"]');
        if (cwEl) {
          cwEl.setAttribute('x1', cw.start.x);
          cwEl.setAttribute('y1', cw.start.y);
          cwEl.setAttribute('x2', cw.end.x);
          cwEl.setAttribute('y2', cw.end.y);
        }
      }
    }
  }

  function pushUndo(changes, inverseChanges) {
    undoStack.push({ changes: changes, inverseChanges: inverseChanges });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }

  function updateUndoButtons() {
    var undoBtn = document.getElementById('btn-undo');
    var redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
    var mUndo = document.getElementById('mobile-undo');
    var mRedo = document.getElementById('mobile-redo');
    if (mUndo) mUndo.disabled = undoStack.length === 0;
    if (mRedo) mRedo.disabled = redoStack.length === 0;
  }

  function commitEndpointDrag() {
    if (!dragState || !plan) { isDragging = false; return; }
    var wall = plan.walls.find(function(w) { return w.id === dragState.wallId; });
    if (!wall) { isDragging = false; return; }

    // Prevent degenerate walls (less than 5cm)
    var wdx = wall.end.x - wall.start.x, wdy = wall.end.y - wall.start.y;
    var wlen = Math.sqrt(wdx * wdx + wdy * wdy);
    if (wlen < 5) {
      // Revert to original positions
      var revert = dragState.originalPositions[dragState.wallId];
      wall.start = revert.start;
      wall.end = revert.end;
      if (dragState.connectedWalls) {
        for (var ri = 0; ri < dragState.connectedWalls.length; ri++) {
          var rc = dragState.connectedWalls[ri];
          var rw = plan.walls.find(function(w) { return w.id === rc.wallId; });
          var ro = dragState.originalPositions[rc.wallId];
          if (rw && ro) { rw.start = ro.start; rw.end = ro.end; }
        }
      }
      isDragging = false;
      dragState = null;
      render();
      return;
    }

    var changes = [];
    var inverseChanges = [];

    // Main wall
    var orig = dragState.originalPositions[dragState.wallId];
    changes.push({ type: 'move_wall', wall_id: dragState.wallId, start: { x: wall.start.x, y: wall.start.y }, end: { x: wall.end.x, y: wall.end.y } });
    inverseChanges.push({ type: 'move_wall', wall_id: dragState.wallId, start: orig.start, end: orig.end });

    // Connected walls (added in Task 6)
    if (!dragState.detached && dragState.connectedWalls) {
      for (var ci = 0; ci < dragState.connectedWalls.length; ci++) {
        var conn = dragState.connectedWalls[ci];
        var cw = plan.walls.find(function(w) { return w.id === conn.wallId; });
        var corig = dragState.originalPositions[conn.wallId];
        if (cw && corig) {
          changes.push({ type: 'move_wall', wall_id: conn.wallId, start: { x: cw.start.x, y: cw.start.y }, end: { x: cw.end.x, y: cw.end.y } });
          inverseChanges.push({ type: 'move_wall', wall_id: conn.wallId, start: corig.start, end: corig.end });
        }
      }
    }

    // Room polygon propagation (added in Task 8)
    var origPt = dragState.startPoint;
    var newPt = dragState.endpoint === 'start' ? wall.start : wall.end;
    if (origPt.x !== newPt.x || origPt.y !== newPt.y) {
      var roomThreshold = 2; // 2cm
      for (var rpi = 0; rpi < plan.rooms.length; rpi++) {
        var room = plan.rooms[rpi];
        var roomChanged = false;
        var newPolygon = room.polygon.map(function(v) {
          if (Math.abs(v.x - origPt.x) <= roomThreshold && Math.abs(v.y - origPt.y) <= roomThreshold) {
            roomChanged = true;
            return { x: newPt.x, y: newPt.y };
          }
          return { x: v.x, y: v.y };
        });
        if (roomChanged) {
          var oldPolygon = room.polygon.map(function(v) { return { x: v.x, y: v.y }; });
          room.polygon = newPolygon;
          room.area = computeArea(newPolygon);
          changes.push({ type: 'update_room', room_id: room.id, polygon: newPolygon });
          inverseChanges.push({ type: 'update_room', room_id: room.id, polygon: oldPolygon });
        }
      }
    }

    // Clear snap guides
    var sgEl = svg.getElementById('snap-guides');
    if (sgEl) sgEl.innerHTML = '';

    if (changes.length > 0) {
      pushUndo(changes, inverseChanges);
      changes.forEach(function(c) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(c));
        }
      });
    }

    isDragging = false;
    dragState = null;
    render();
    showProperties();
  }

  function updateFurnitureRotation(e) {
    // Implemented in Task 11
  }

  function commitFurnitureRotation() {
    // Implemented in Task 11
  }

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', function(e) {
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

  // --- Init ---
  load();
})();
</script>
</body>
</html>`;
}
