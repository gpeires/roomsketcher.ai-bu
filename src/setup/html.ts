export function setupHtml(mcpUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Set Up RoomSketcher AI — Connect Your AI Assistant</title>
<meta name="description" content="Add the RoomSketcher AI floor plan designer to Claude, ChatGPT, Gemini, or Perplexity in under a minute.">
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
    --rs-success: #22C55E;
    --radius: 12px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Merriweather Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: var(--rs-dark);
    background: var(--rs-teal-bg);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  /* Header */
  .header {
    background: var(--rs-dark);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .header img { height: 32px; width: 32px; border-radius: 6px; }
  .header .brand { color: #fff; font-size: 16px; font-weight: 700; }
  .header .brand span { color: var(--rs-teal-light); font-weight: 300; }

  /* Hero */
  .hero {
    text-align: center;
    padding: 48px 24px 32px;
    max-width: 640px;
    margin: 0 auto;
  }
  .hero h1 {
    font-size: 28px;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 12px;
  }
  .hero p {
    font-size: 16px;
    color: var(--rs-gray);
    line-height: 1.5;
    max-width: 480px;
    margin: 0 auto;
  }

  /* URL copy box */
  .url-box {
    max-width: 520px;
    margin: 24px auto 0;
    display: flex;
    background: var(--rs-white);
    border: 2px solid var(--rs-gray-light);
    border-radius: var(--radius);
    overflow: hidden;
    transition: border-color 0.2s;
  }
  .url-box:focus-within { border-color: var(--rs-teal); }
  .url-box code {
    flex: 1;
    padding: 12px 16px;
    font-size: 14px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    color: var(--rs-dark);
    background: none;
    border: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    user-select: all;
    -webkit-user-select: all;
  }
  .url-box button {
    padding: 12px 20px;
    background: var(--rs-dark);
    color: #fff;
    border: none;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: background 0.15s;
    white-space: nowrap;
  }
  .url-box button:hover { background: var(--rs-gray); }
  .url-box button.copied { background: var(--rs-success); }
  .url-box button svg { width: 16px; height: 16px; }

  /* Platform cards */
  .platforms {
    max-width: 720px;
    margin: 40px auto;
    padding: 0 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .platform-card {
    background: var(--rs-white);
    border-radius: var(--radius);
    border: 1px solid var(--rs-gray-light);
    overflow: hidden;
    transition: box-shadow 0.2s;
  }
  .platform-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.06); }

  .card-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    cursor: pointer;
    user-select: none;
  }
  .card-header .icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
  }
  .card-header .icon.claude { background: #F4E8D1; }
  .card-header .icon.chatgpt { background: #D9F2E6; }
  .card-header .icon.gemini { background: #E0E7FF; }
  .card-header .icon.perplexity { background: #E8F0FE; }

  .card-header .info { flex: 1; }
  .card-header .info h3 { font-size: 16px; font-weight: 600; margin-bottom: 2px; }
  .card-header .info .subtitle { font-size: 13px; color: var(--rs-gray); }

  .card-header .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 20px;
    white-space: nowrap;
  }
  .badge.recommended { background: var(--rs-gold); color: var(--rs-dark); }
  .badge.supported { background: #E0F2FE; color: #0369A1; }

  .card-header .chevron {
    width: 20px;
    height: 20px;
    color: var(--rs-gray);
    transition: transform 0.2s;
    flex-shrink: 0;
  }
  .platform-card.open .chevron { transform: rotate(180deg); }

  .card-body {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.3s ease;
  }
  .platform-card.open .card-body { max-height: 600px; }

  .card-content {
    padding: 0 20px 20px;
    border-top: 1px solid var(--rs-gray-light);
  }

  .steps {
    list-style: none;
    counter-reset: step;
    margin-top: 16px;
  }
  .steps li {
    counter-increment: step;
    position: relative;
    padding-left: 36px;
    padding-bottom: 16px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--rs-dark);
  }
  .steps li:last-child { padding-bottom: 0; }
  .steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: 1px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--rs-teal-bg);
    color: var(--rs-teal-dark);
    font-size: 12px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1.5px solid var(--rs-teal-light);
  }
  .steps li strong { font-weight: 600; }
  .steps li code {
    background: var(--rs-teal-bg);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    color: var(--rs-teal-dark);
    word-break: break-all;
  }
  .steps li .note {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    color: var(--rs-gray);
    font-style: italic;
  }
  .steps li a {
    color: var(--rs-teal-dark);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .inline-copy {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--rs-teal-bg);
    padding: 2px 8px 2px 6px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: border-color 0.15s;
  }
  .inline-copy:hover { border-color: var(--rs-teal-light); }
  .inline-copy code { background: none; padding: 0; }
  .inline-copy svg { width: 12px; height: 12px; color: var(--rs-gray); flex-shrink: 0; }

  /* Platforms grid for wider screens */
  .platform-prereq {
    background: var(--rs-teal-bg);
    padding: 10px 14px;
    border-radius: 8px;
    margin-top: 12px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--rs-gray);
  }
  .platform-prereq strong { color: var(--rs-dark); }

  /* CTA */
  .cta-section {
    text-align: center;
    padding: 40px 24px 60px;
  }
  .cta-section p {
    font-size: 14px;
    color: var(--rs-gray);
    margin-bottom: 16px;
  }
  .cta-section a {
    display: inline-block;
    padding: 12px 28px;
    background: var(--rs-gold);
    color: var(--rs-dark);
    text-decoration: none;
    font-weight: 700;
    font-size: 15px;
    border-radius: var(--radius);
    transition: background 0.15s;
  }
  .cta-section a:hover { background: var(--rs-gold-light); }

  /* Mobile tweaks */
  @media (max-width: 480px) {
    .hero h1 { font-size: 22px; }
    .hero { padding: 32px 16px 24px; }
    .url-box code { font-size: 12px; }
    .card-header { padding: 14px 16px; }
    .card-content { padding: 0 16px 16px; }
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
  <h1>Add RoomSketcher AI to your favorite assistant</h1>
  <p>Design floor plans with AI. Connect in under a minute — just paste the URL below into your AI app.</p>

  <div class="url-box">
    <code id="mcp-url">${mcpUrl}</code>
    <button id="copy-btn" onclick="copyUrl()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <span>Copy</span>
    </button>
  </div>
</div>

<!-- Claude -->
<div class="platforms">

  <div class="platform-card open" id="card-claude">
    <div class="card-header" onclick="toggle('card-claude')">
      <div class="icon claude">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M16.1 3.58c-.26-.1-.56.02-.72.24L8.81 13.4a.5.5 0 0 0 .4.78h3.53l-3.2 6.44c-.17.35.22.7.56.5L20.8 12a.5.5 0 0 0-.24-.85h-3.65l2.33-5.97c.13-.34-.12-.7-.49-.7h-2.65z" fill="#D97706"/></svg>
      </div>
      <div class="info">
        <h3>Claude</h3>
        <div class="subtitle">claude.ai, Desktop & Mobile</div>
      </div>
      <span class="badge recommended">Recommended</span>
      <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="card-body">
      <div class="card-content">
        <div class="platform-prereq">
          <strong>Requires:</strong> Claude Pro, Team, or Enterprise plan
        </div>
        <ol class="steps">
          <li>Open <a href="https://claude.ai" target="_blank" rel="noopener">claude.ai</a> and go to <strong>Settings</strong></li>
          <li>Click <strong>Integrations</strong> in the left sidebar</li>
          <li>Click <strong>Add Integration</strong> (or "Add Custom Connector")</li>
          <li>Paste the URL: <span class="inline-copy" onclick="copyUrl(event)"><code>${mcpUrl}</code><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span></li>
          <li>Name it <strong>RoomSketcher</strong> and save</li>
          <li>Start a new chat and ask Claude to design a floor plan!
            <span class="note">Settings sync automatically to Claude Desktop and mobile apps.</span>
          </li>
        </ol>
      </div>
    </div>
  </div>

  <!-- ChatGPT -->
  <div class="platform-card" id="card-chatgpt">
    <div class="card-header" onclick="toggle('card-chatgpt')">
      <div class="icon chatgpt">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#10A37F" stroke-width="2"/><path d="M8 12h8M12 8v8" stroke="#10A37F" stroke-width="2" stroke-linecap="round"/></svg>
      </div>
      <div class="info">
        <h3>ChatGPT</h3>
        <div class="subtitle">chatgpt.com, Desktop & Mobile</div>
      </div>
      <span class="badge supported">Supported</span>
      <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="card-body">
      <div class="card-content">
        <div class="platform-prereq">
          <strong>Requires:</strong> ChatGPT Plus or Team plan with Developer Mode enabled
        </div>
        <ol class="steps">
          <li>Open <a href="https://chatgpt.com" target="_blank" rel="noopener">chatgpt.com</a> and go to <strong>Settings</strong></li>
          <li>Navigate to <strong>Apps</strong> (or <strong>Connectors</strong>)</li>
          <li>Click <strong>Add App</strong> and select <strong>Connect by URL</strong></li>
          <li>Paste the URL: <span class="inline-copy" onclick="copyUrl(event)"><code>${mcpUrl}</code><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span></li>
          <li>Approve the connection and start chatting
            <span class="note">ChatGPT will automatically discover the available tools.</span>
          </li>
        </ol>
      </div>
    </div>
  </div>

  <!-- Gemini -->
  <div class="platform-card" id="card-gemini">
    <div class="card-header" onclick="toggle('card-gemini')">
      <div class="icon gemini">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#4F46E5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="info">
        <h3>Gemini</h3>
        <div class="subtitle">gemini.google.com & Gemini CLI</div>
      </div>
      <span class="badge supported">Supported</span>
      <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="card-body">
      <div class="card-content">
        <div class="platform-prereq">
          <strong>Requires:</strong> Gemini CLI installed, or Gemini Advanced
        </div>
        <ol class="steps">
          <li>Open your terminal and run:<br><code>gemini cli</code></li>
          <li>In the Gemini CLI settings, add a new MCP server</li>
          <li>Set the URL to: <span class="inline-copy" onclick="copyUrl(event)"><code>${mcpUrl}</code><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span></li>
          <li>Set transport to <strong>Streamable HTTP</strong></li>
          <li>Ask Gemini to design your floor plan
            <span class="note">For browser-based Gemini, check Settings > Extensions for MCP support.</span>
          </li>
        </ol>
      </div>
    </div>
  </div>

  <!-- Perplexity -->
  <div class="platform-card" id="card-perplexity">
    <div class="card-header" onclick="toggle('card-perplexity')">
      <div class="icon perplexity">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="#2563EB" stroke-width="2"/><path d="M12 2v4m0 12v4m-10-10h4m12 0h4m-3.07-6.93l-2.83 2.83m-8.2 8.2l-2.83 2.83m0-14.14l2.83 2.83m8.2 8.2l2.83 2.83" stroke="#2563EB" stroke-width="2" stroke-linecap="round"/></svg>
      </div>
      <div class="info">
        <h3>Perplexity</h3>
        <div class="subtitle">perplexity.ai</div>
      </div>
      <span class="badge supported">Supported</span>
      <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="card-body">
      <div class="card-content">
        <div class="platform-prereq">
          <strong>Requires:</strong> Perplexity Pro plan
        </div>
        <ol class="steps">
          <li>Open <a href="https://perplexity.ai" target="_blank" rel="noopener">perplexity.ai</a> and go to <strong>Settings</strong></li>
          <li>Find <strong>MCP Servers</strong> or <strong>Custom Remote Connectors</strong></li>
          <li>Click <strong>Add Connector</strong></li>
          <li>Paste the URL: <span class="inline-copy" onclick="copyUrl(event)"><code>${mcpUrl}</code><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span></li>
          <li>Save and start a new thread to design floor plans
            <span class="note">Perplexity uses Streamable HTTP transport natively.</span>
          </li>
        </ol>
      </div>
    </div>
  </div>

</div>

<div class="cta-section">
  <p>Want professional 3D floor plans, live walkthroughs, and high-res exports?</p>
  <a href="https://www.roomsketcher.com/?utm_source=ai-sketcher&utm_medium=setup-page&utm_campaign=sketch-upgrade">Explore RoomSketcher Pro</a>
</div>

<script>
function copyUrl(e) {
  if (e) e.stopPropagation();
  var url = document.getElementById('mcp-url').textContent;
  navigator.clipboard.writeText(url).then(function() {
    var btn = document.getElementById('copy-btn');
    btn.classList.add('copied');
    btn.querySelector('span').textContent = 'Copied!';
    setTimeout(function() {
      btn.classList.remove('copied');
      btn.querySelector('span').textContent = 'Copy';
    }, 2000);
  });
}

function toggle(id) {
  document.getElementById(id).classList.toggle('open');
}
</script>

</body>
</html>`;
}
