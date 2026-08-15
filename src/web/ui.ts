/**
 * The editor UI, as three static assets.
 *
 * No build step, no framework, no CDN: the page is served from the same
 * loopback process that owns the files, and a dependency-free UI keeps the
 * Content-Security-Policy tight (`default-src 'none'`, everything from 'self',
 * no inline script). It also means the editor keeps working offline, which is
 * the point of a local-first tool.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model workspace — creality-agent-tool</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header>
  <h1>Model workspace</h1>
  <p id="toolchain" class="badge">checking OpenSCAD…</p>
</header>

<main>
  <section class="panel projects">
    <h2>Projects</h2>
    <ul id="project-list"></ul>
    <p class="hint">Projects are created by the agent. Ask it for a part, then edit the
    OpenSCAD source here.</p>
  </section>

  <section class="panel editor">
    <div class="editor-head">
      <div>
        <h2 id="project-name">No project selected</h2>
        <p id="project-meta" class="meta"></p>
      </div>
      <div class="actions">
        <button id="save" type="button" disabled>Save</button>
        <button id="render" type="button" disabled>Render preview</button>
        <button id="export-stl" type="button" disabled>Export STL</button>
        <button id="export-3mf" type="button" disabled>Export 3MF</button>
      </div>
    </div>

    <details id="prompt-box">
      <summary>Original prompt</summary>
      <p id="project-prompt" class="prompt"></p>
    </details>

    <label class="sr-only" for="source">OpenSCAD source</label>
    <textarea id="source" spellcheck="false" disabled
      placeholder="Select a project to edit its OpenSCAD source."></textarea>

    <p id="status" class="status" role="status" aria-live="polite"></p>

    <section class="previews">
      <h3>Preview</h3>
      <div id="preview-grid" class="preview-grid"></div>
      <h3>Artifacts</h3>
      <ul id="artifact-list" class="artifacts"></ul>
    </section>
  </section>
</main>

<footer>
  <p>Localhost only. This editor cannot move, heat, or print on a printer —
  printer actions live behind the MCP tools and their confirmation flow.</p>
</footer>

<script src="/app.js" type="module"></script>
</body>
</html>
`;

export const APP_CSS = `:root {
  color-scheme: light dark;
  --bg: #10131a;
  --panel: #171b24;
  --line: #29303d;
  --text: #e6e9ef;
  --muted: #98a2b3;
  --accent: #4c9aff;
  --warn: #f0a500;
  --bad: #ff6b6b;
  --good: #3ddc97;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
}
header {
  display: flex; align-items: center; gap: 1rem;
  padding: 0.75rem 1.25rem; border-bottom: 1px solid var(--line);
}
h1 { font-size: 1.05rem; margin: 0; }
h2 { font-size: 0.95rem; margin: 0 0 0.5rem; }
h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em;
     color: var(--muted); margin: 1.25rem 0 0.5rem; }
main {
  display: grid; grid-template-columns: minmax(200px, 260px) 1fr;
  gap: 1rem; padding: 1rem 1.25rem; align-items: start;
}
@media (max-width: 820px) { main { grid-template-columns: 1fr; } }
.panel { background: var(--panel); border: 1px solid var(--line);
         border-radius: 10px; padding: 1rem; }
.badge { margin: 0; font-size: 0.8rem; color: var(--muted); }
.badge.ok { color: var(--good); }
.badge.bad { color: var(--bad); }
#project-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
#project-list button {
  width: 100%; text-align: left; background: transparent; color: var(--text);
  border: 1px solid transparent; border-radius: 6px; padding: 0.45rem 0.55rem;
  cursor: pointer; font: inherit;
}
#project-list button:hover { border-color: var(--line); }
#project-list button[aria-current="true"] { border-color: var(--accent); background: #1e2635; }
#project-list .rev { display: block; color: var(--muted); font-size: 0.75rem; }
.editor-head { display: flex; justify-content: space-between; gap: 1rem;
               flex-wrap: wrap; align-items: flex-start; }
.actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
button {
  font: inherit; background: #222a38; color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; padding: 0.4rem 0.7rem; cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
#save { border-color: var(--accent); }
textarea {
  width: 100%; min-height: 22rem; margin-top: 0.75rem; padding: 0.75rem;
  background: #0d1017; color: var(--text); border: 1px solid var(--line);
  border-radius: 8px; resize: vertical;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 13px;
  tab-size: 2;
}
.meta, .prompt { color: var(--muted); margin: 0.25rem 0 0; font-size: 0.8rem; }
.prompt { white-space: pre-wrap; }
#prompt-box { margin-top: 0.75rem; font-size: 0.8rem; color: var(--muted); }
.status { min-height: 1.4rem; margin: 0.6rem 0 0; font-size: 0.85rem; }
.status.busy { color: var(--accent); }
.status.ok { color: var(--good); }
.status.bad { color: var(--bad); white-space: pre-wrap; }
.status.warn { color: var(--warn); }
.preview-grid { display: grid; gap: 0.75rem;
                grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.preview-grid figure { margin: 0; border: 1px solid var(--line); border-radius: 8px;
                       overflow: hidden; background: #0d1017; }
.preview-grid img { width: 100%; display: block; background: #fff; }
.preview-grid figcaption { padding: 0.35rem 0.5rem; font-size: 0.75rem; color: var(--muted); }
.artifacts { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.3rem; }
.artifacts a { color: var(--accent); }
.artifacts span { color: var(--muted); font-size: 0.78rem; }
.hint { color: var(--muted); font-size: 0.78rem; margin-top: 0.75rem; }
footer { padding: 0.5rem 1.25rem 1.5rem; color: var(--muted); font-size: 0.78rem; }
.sr-only {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap;
}
`;

export const APP_JS = `const $ = (id) => document.getElementById(id);
const listEl = $('project-list');
const sourceEl = $('source');
const statusEl = $('status');
const previewEl = $('preview-grid');
const artifactEl = $('artifact-list');
const buttons = ['save', 'render', 'export-stl', 'export-3mf'].map($);

let current = null;
let busy = false;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function setBusy(value) {
  busy = value;
  for (const button of buttons) button.disabled = value || current === null;
}

async function call(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!response.ok) {
    const error = body && body.error ? body.error : {};
    const message = error.message || ('Request failed with HTTP ' + response.status);
    throw new Error(error.code ? error.code + ': ' + message : message);
  }
  return body;
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function refreshToolchain() {
  const badge = $('toolchain');
  try {
    const status = await call('/api/toolchain');
    if (status.available) {
      badge.textContent = 'OpenSCAD ' + (status.version || 'ready') + ' — ' + status.path;
      badge.className = 'badge ok';
    } else {
      badge.textContent = status.reason || 'OpenSCAD is not available.';
      badge.className = 'badge bad';
    }
  } catch (error) {
    badge.textContent = String(error.message || error);
    badge.className = 'badge bad';
  }
}

async function refreshProjects(selectId) {
  const data = await call('/api/projects');
  listEl.replaceChildren();
  for (const project of data.projects) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = project.name;
    button.setAttribute('aria-current', String(project.id === selectId));
    const rev = document.createElement('span');
    rev.className = 'rev';
    rev.textContent = 'rev ' + project.revision + ' · ' + project.id;
    button.append(rev);
    button.addEventListener('click', () => { void open(project.id); });
    item.append(button);
    listEl.append(item);
  }
  if (data.projects.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = 'No projects yet.';
    listEl.append(empty);
  }
}

function renderArtifacts(project) {
  previewEl.replaceChildren();
  artifactEl.replaceChildren();
  const stamp = '?v=' + Date.now();
  for (const artifact of project.artifacts) {
    if (artifact.kind === 'preview') {
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      image.src = artifact.href + stamp;
      image.alt = artifact.name;
      image.loading = 'lazy';
      const caption = document.createElement('figcaption');
      caption.textContent = artifact.name.replace(/^preview-|\\.png$/g, '');
      figure.append(image, caption);
      previewEl.append(figure);
    }
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = artifact.href + stamp;
    link.textContent = artifact.name;
    link.download = artifact.name;
    const size = document.createElement('span');
    size.textContent = ' — ' + Math.max(1, Math.round(artifact.bytes / 1024)) + ' KiB';
    item.append(link, size);
    artifactEl.append(item);
  }
  if (project.artifacts.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = 'Nothing built yet — save, then render a preview.';
    artifactEl.append(empty);
  }
}

function show(project) {
  current = project;
  $('project-name').textContent = project.name;
  $('project-meta').textContent =
    'revision ' + project.revision + ' · ' + project.bytes + ' bytes · updated ' +
    new Date(project.updatedAt).toLocaleString();
  $('project-prompt').textContent = project.prompt || '(none recorded)';
  sourceEl.value = project.source;
  sourceEl.disabled = false;
  renderArtifacts(project);
  setBusy(false);
}

async function open(id) {
  setStatus('Loading ' + id + '…', 'busy');
  try {
    const project = await call('/api/projects/' + encodeURIComponent(id));
    show(project);
    await refreshProjects(id);
    setStatus('');
  } catch (error) {
    setStatus(String(error.message || error), 'bad');
  }
}

async function act(label, run) {
  if (current === null || busy) return;
  setBusy(true);
  setStatus(label + '…', 'busy');
  try {
    const result = await run(current.id);
    const project = await call('/api/projects/' + encodeURIComponent(current.id));
    show(project);
    const warnings = (result && result.warnings) || [];
    setStatus(
      warnings.length > 0 ? label + ' finished with warnings:\\n' + warnings.join('\\n')
                          : label + ' finished.',
      warnings.length > 0 ? 'warn' : 'ok',
    );
  } catch (error) {
    setStatus(String(error.message || error), 'bad');
    setBusy(false);
  }
}

$('save').addEventListener('click', () => {
  void act('Save', (id) =>
    call('/api/projects/' + encodeURIComponent(id) + '/save', json({ source: sourceEl.value })));
});
$('render').addEventListener('click', () => {
  void act('Render', (id) =>
    call('/api/projects/' + encodeURIComponent(id) + '/render', json({})));
});
$('export-stl').addEventListener('click', () => {
  void act('Export STL', (id) =>
    call('/api/projects/' + encodeURIComponent(id) + '/export', json({ format: 'stl' })));
});
$('export-3mf').addEventListener('click', () => {
  void act('Export 3MF', (id) =>
    call('/api/projects/' + encodeURIComponent(id) + '/export', json({ format: '3mf' })));
});

sourceEl.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    $('save').click();
  }
});

void refreshToolchain();
void refreshProjects(null).catch((error) => { setStatus(String(error.message || error), 'bad'); });
`;
