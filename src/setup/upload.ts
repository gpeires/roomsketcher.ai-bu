export function uploadHtml(workerUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Upload Floor Plan — RoomSketcher AI</title>
<link rel="icon" type="image/png" href="https://wpmedia.roomsketcher.com/content/uploads/2021/12/15075948/roomsketcher-logo-square.png">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; }
  .container { max-width: 600px; margin: 60px auto; padding: 0 20px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p.sub { color: #666; margin-bottom: 24px; }
  .drop-zone {
    border: 2px dashed #ccc; border-radius: 12px; padding: 60px 20px;
    text-align: center; cursor: pointer; transition: all 0.2s;
    background: #fff;
  }
  .drop-zone:hover, .drop-zone.over { border-color: #00B5CC; background: #f0fafb; }
  .drop-zone img { max-width: 100%; max-height: 300px; border-radius: 8px; margin-top: 12px; }
  .drop-zone .placeholder { color: #999; font-size: 16px; }
  .drop-zone .placeholder span { display: block; font-size: 13px; margin-top: 6px; color: #bbb; }
  .result { margin-top: 20px; display: none; }
  .result .url-box {
    display: flex; gap: 8px; align-items: center;
    background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 12px;
  }
  .result input { flex: 1; border: none; font-size: 14px; font-family: monospace; outline: none; background: transparent; }
  .result button {
    background: #00B5CC; color: #fff; border: none; border-radius: 6px;
    padding: 8px 16px; cursor: pointer; font-size: 14px; white-space: nowrap;
  }
  .result button:hover { background: #007B8C; }
  .result .hint { font-size: 13px; color: #666; margin-top: 8px; }
  .uploading { color: #00B5CC; margin-top: 16px; display: none; }
  .error { color: #c00; margin-top: 16px; display: none; }
  input[type="file"] { display: none; }
</style>
</head>
<body>
<div class="container">
  <h1>Upload Floor Plan Image</h1>
  <p class="sub">Drop or paste a floor plan image. You'll get a URL to give to Claude for CV analysis.</p>

  <div class="drop-zone" id="dropZone">
    <div class="placeholder" id="placeholder">
      Drop image here, click to select, or paste from clipboard
      <span>PNG, JPG — max 10 MB</span>
    </div>
    <img id="preview" style="display:none" />
  </div>
  <input type="file" id="fileInput" accept="image/png,image/jpeg" />

  <div class="uploading" id="uploading">Uploading...</div>
  <div class="error" id="error"></div>

  <div class="result" id="result">
    <div class="url-box">
      <input id="urlField" readonly />
      <button onclick="copyUrl()">Copy</button>
    </div>
    <p class="hint">Paste this URL in your Claude conversation. Claude will use it with the analyze_floor_plan_image tool.</p>
  </div>
</div>
<script>
const WORKER = ${JSON.stringify(workerUrl)};
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const preview = document.getElementById('preview');
const placeholder = document.getElementById('placeholder');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('over');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });

document.addEventListener('paste', e => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      handleFile(item.getAsFile());
      return;
    }
  }
});

function handleFile(file) {
  if (!file || file.size > 10 * 1024 * 1024) {
    showError('File too large (max 10 MB)');
    return;
  }
  // Show preview
  const reader = new FileReader();
  reader.onload = () => {
    preview.src = reader.result;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
  };
  reader.readAsDataURL(file);
  uploadFile(file);
}

async function uploadFile(file) {
  document.getElementById('uploading').style.display = 'block';
  document.getElementById('error').style.display = 'none';
  document.getElementById('result').style.display = 'none';
  try {
    const resp = await fetch(WORKER + '/api/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    document.getElementById('urlField').value = data.url;
    document.getElementById('result').style.display = 'block';
  } catch (err) {
    showError(err.message);
  } finally {
    document.getElementById('uploading').style.display = 'none';
  }
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = 'block';
}

function copyUrl() {
  const field = document.getElementById('urlField');
  navigator.clipboard.writeText(field.value);
  document.querySelector('.result button').textContent = 'Copied!';
  setTimeout(() => { document.querySelector('.result button').textContent = 'Copy'; }, 2000);
}
</script>
</body>
</html>`;
}
