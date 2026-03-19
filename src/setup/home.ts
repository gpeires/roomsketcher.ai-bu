export function homeHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RoomSketcher AI Sketcher — Design Floor Plans with AI</title>
<meta name="description" content="Design professional floor plans by chatting with AI. Works with Claude, ChatGPT, Gemini, and Perplexity.">
<link rel="icon" type="image/png" href="https://wpmedia.roomsketcher.com/content/uploads/2021/12/15075948/roomsketcher-logo-square.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Merriweather+Sans:wght@300;400;600;700&display=swap" rel="stylesheet">
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
    --rs-white: #FFFFFF;
    --radius: 12px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Merriweather Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: var(--rs-dark);
    background: var(--rs-dark);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  /* Header */
  .header {
    padding: 16px 24px;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 960px;
    margin: 0 auto;
  }
  .header img { height: 32px; width: 32px; border-radius: 6px; }
  .header .brand { color: #fff; font-size: 16px; font-weight: 700; }
  .header .brand span { color: var(--rs-teal-light); font-weight: 300; }

  /* Hero */
  .hero {
    text-align: center;
    padding: 60px 24px 48px;
    max-width: 700px;
    margin: 0 auto;
  }
  .hero h1 {
    font-size: 40px;
    font-weight: 700;
    line-height: 1.2;
    color: #fff;
    margin-bottom: 16px;
    letter-spacing: -0.5px;
  }
  .hero h1 em {
    font-style: normal;
    color: var(--rs-teal-light);
  }
  .hero p {
    font-size: 18px;
    color: var(--rs-gray-light);
    line-height: 1.6;
    max-width: 520px;
    margin: 0 auto 32px;
  }
  .hero-actions {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 14px 28px;
    border-radius: var(--radius);
    font-family: inherit;
    font-size: 15px;
    font-weight: 700;
    text-decoration: none;
    border: none;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
  }
  .btn:active { transform: scale(0.98); }
  .btn-primary {
    background: var(--rs-gold);
    color: var(--rs-dark);
  }
  .btn-primary:hover { background: var(--rs-gold-light); }
  .btn-secondary {
    background: rgba(255,255,255,0.1);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.2);
  }
  .btn-secondary:hover { background: rgba(255,255,255,0.15); }
  .btn svg { width: 18px; height: 18px; }

  /* Features */
  .features {
    background: var(--rs-teal-bg);
    padding: 56px 24px;
  }
  .features-inner {
    max-width: 800px;
    margin: 0 auto;
  }
  .features h2 {
    text-align: center;
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .features .sub {
    text-align: center;
    font-size: 15px;
    color: var(--rs-gray);
    margin-bottom: 36px;
  }
  .feature-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 20px;
  }
  .feature-card {
    background: var(--rs-white);
    border-radius: var(--radius);
    padding: 24px;
    border: 1px solid var(--rs-gray-light);
  }
  .feature-card .icon {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    background: var(--rs-teal-bg);
    border: 1.5px solid var(--rs-teal-light);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 14px;
    font-size: 22px;
  }
  .feature-card h3 {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .feature-card p {
    font-size: 13px;
    color: var(--rs-gray);
    line-height: 1.5;
  }

  /* Platforms */
  .platforms-bar {
    padding: 40px 24px;
    text-align: center;
    background: var(--rs-white);
    border-top: 1px solid var(--rs-gray-light);
  }
  .platforms-bar p {
    font-size: 13px;
    color: var(--rs-gray);
    text-transform: uppercase;
    letter-spacing: 1.2px;
    font-weight: 600;
    margin-bottom: 20px;
  }
  .platform-logos {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 32px;
    flex-wrap: wrap;
  }
  .platform-logos .platform {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 600;
    color: var(--rs-gray);
  }
  .platform-logos .dot {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
  }

  /* Try it */
  .try-section {
    padding: 56px 24px;
    text-align: center;
    background: var(--rs-teal-bg);
    border-top: 1px solid var(--rs-gray-light);
  }
  .try-section h2 {
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .try-section p {
    font-size: 15px;
    color: var(--rs-gray);
    margin-bottom: 24px;
  }
  .prompt-examples {
    max-width: 520px;
    margin: 0 auto 28px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .prompt-example {
    background: var(--rs-white);
    border: 1px solid var(--rs-gray-light);
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 14px;
    color: var(--rs-dark);
    text-align: left;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .prompt-example .q {
    color: var(--rs-teal-dark);
    font-weight: 600;
    font-size: 13px;
    white-space: nowrap;
  }

  /* Footer */
  .footer {
    padding: 32px 24px;
    text-align: center;
    background: var(--rs-dark);
    border-top: 1px solid rgba(255,255,255,0.1);
  }
  .footer p {
    font-size: 13px;
    color: var(--rs-gray);
    line-height: 1.6;
  }
  .footer a {
    color: var(--rs-teal-light);
    text-decoration: none;
  }
  .footer a:hover { text-decoration: underline; }
  .footer .links {
    margin-top: 12px;
    display: flex;
    justify-content: center;
    gap: 24px;
  }

  @media (max-width: 480px) {
    .hero h1 { font-size: 28px; }
    .hero p { font-size: 16px; }
    .hero { padding: 40px 16px 36px; }
    .hero-actions { flex-direction: column; align-items: center; }
    .btn { width: 100%; max-width: 280px; justify-content: center; }
    .platform-logos { gap: 20px; }
  }
</style>
</head>
<body>

<div class="header">
  <a href="/" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit">
    <img src="https://wpmedia.roomsketcher.com/content/uploads/2021/12/15075948/roomsketcher-logo-square.png" alt="RoomSketcher">
    <div class="brand">RoomSketcher <span>AI Sketcher</span></div>
  </a>
</div>

<div class="hero">
  <h1>Design floor plans by <em>chatting with AI</em></h1>
  <p>Describe the space you want. Get a professional 2D floor plan in seconds — complete with furniture, dimensions, and room labels.</p>
  <div class="hero-actions">
    <a href="/setup" class="btn btn-primary">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Connect Your AI App
    </a>
    <a href="https://www.roomsketcher.com/?utm_source=ai-sketcher&utm_medium=home&utm_campaign=sketch-upgrade" class="btn btn-secondary">
      Learn About RoomSketcher
    </a>
  </div>
</div>

<div class="features">
  <div class="features-inner">
    <h2>What can it do?</h2>
    <p class="sub">The RoomSketcher AI Sketcher adds floor plan superpowers to your AI assistant.</p>
    <div class="feature-grid">
      <div class="feature-card">
        <div class="icon">&#9633;</div>
        <h3>Generate Floor Plans</h3>
        <p>Describe a room or entire home. AI creates a dimensioned, furnished plan from templates.</p>
      </div>
      <div class="feature-card">
        <div class="icon">&#9998;</div>
        <h3>Edit in Real-Time</h3>
        <p>Move walls, add doors and windows, rearrange furniture. Changes appear live in the browser sketcher.</p>
      </div>
      <div class="feature-card">
        <div class="icon">&#128218;</div>
        <h3>Design Knowledge</h3>
        <p>Backed by 190+ RoomSketcher help articles. AI knows clearances, placements, and best practices.</p>
      </div>
      <div class="feature-card">
        <div class="icon">&#8681;</div>
        <h3>Export SVG</h3>
        <p>Download your plan as a clean SVG. Ready for presentations, printing, or further editing.</p>
      </div>
    </div>
  </div>
</div>

<div class="platforms-bar">
  <p>Works with your favorite AI</p>
  <div class="platform-logos">
    <div class="platform"><div class="dot" style="background:#F4E8D1">&#9889;</div> Claude</div>
    <div class="platform"><div class="dot" style="background:#D9F2E6">&#9679;</div> ChatGPT</div>
    <div class="platform"><div class="dot" style="background:#E0E7FF">&#9670;</div> Gemini</div>
    <div class="platform"><div class="dot" style="background:#E8F0FE">&#10022;</div> Perplexity</div>
  </div>
</div>

<div class="try-section">
  <h2>Try saying...</h2>
  <p>Once connected, just ask your AI assistant naturally.</p>
  <div class="prompt-examples">
    <div class="prompt-example">
      <span class="q">Try:</span> "Design a 2-bedroom apartment with an open kitchen"
    </div>
    <div class="prompt-example">
      <span class="q">Try:</span> "Add a bathroom with a shower next to the bedroom"
    </div>
    <div class="prompt-example">
      <span class="q">Try:</span> "Move the sofa to face the window and add a bookshelf"
    </div>
    <div class="prompt-example">
      <span class="q">Try:</span> "Make the kitchen bigger and add an island counter"
    </div>
  </div>
  <a href="/setup" class="btn btn-primary">Get Started</a>
</div>

<div class="footer">
  <p>Powered by <a href="https://www.roomsketcher.com/?utm_source=ai-sketcher&utm_medium=home-footer&utm_campaign=sketch-upgrade">RoomSketcher</a> &mdash; Professional floor plans, 3D walkthroughs, and more.</p>
  <div class="links">
    <a href="/setup">Setup Guide</a>
    <a href="/health">API Status</a>
    <a href="https://www.roomsketcher.com/?utm_source=ai-sketcher&utm_medium=home-footer&utm_campaign=sketch-upgrade">RoomSketcher.com</a>
  </div>
</div>

</body>
</html>`;
}
