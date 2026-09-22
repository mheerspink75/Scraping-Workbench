const sel = document.getElementById('fileSelect');
const content = document.getElementById('content');
const status = document.getElementById('status');

async function listFiles(keepSelection = true) {
  const prev = keepSelection ? sel.value : null;
  const res = await fetch('/api/files');
  const files = await res.json();
  sel.innerHTML = '';
  for (const f of files) {
    const opt = document.createElement('option');
    opt.value = f.path;
    opt.textContent = `${f.path} (${f.size} B, ${f.mtime})`;
    sel.appendChild(opt);
  }
  if (prev && files.some(f => f.path === prev)) sel.value = prev;
  if (sel.value) loadFile(sel.value);
}

function renderMarkdown(md) {
  // Minimal markdown renderer: headings, bold/italic, code, links, lists.
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = md.split('\n');
  let html = '', inList = false, inCode = false;
  for (let line of lines) {
    if (line.trim().startsWith('```')) { html += inCode ? '</pre>' : '<pre>'; inCode = !inCode; continue; }
    if (inCode) { html += esc(line) + '\n'; continue; }
    const inline = s => esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { if (inList) { html += '</ul>'; inList = false; }
      html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    html += line.trim() ? '<p>' + inline(line) + '</p>' : '';
  }
  if (inList) html += '</ul>';
  if (inCode) html += '</pre>';
  return '<div class="md">' + html + '</div>';
}

async function loadFile(path) {
  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(path));
    const data = await res.json();
    if (data.error) { content.innerHTML = '<span class="err">' + data.error + '</span>'; return; }
    content.classList.remove('empty');
    if (data.type === 'csv') {
      let html = '<table><thead><tr>' + data.headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
      for (const row of data.rows) html += '<tr>' + row.map(c => `<td>${c}</td>`).join('') + '</tr>';
      content.innerHTML = html + '</tbody></table>';
    } else if (data.type === 'markdown') {
      content.innerHTML = renderMarkdown(data.text);
    } else {
      content.innerHTML = '<pre></pre>';
      content.firstChild.textContent = data.text;
    }
    status.textContent = 'loaded ' + new Date().toLocaleTimeString();
  } catch (e) {
    content.innerHTML = '<span class="err">Error: ' + e.message + '</span>';
  }
}

sel.addEventListener('change', () => loadFile(sel.value));
document.getElementById('refreshBtn').addEventListener('click', () => listFiles());
let timer = null;
document.getElementById('autoRefresh').addEventListener('change', e => {
  if (e.target.checked) timer = setInterval(() => listFiles(), 3000);
  else clearInterval(timer);
});
listFiles(false);
