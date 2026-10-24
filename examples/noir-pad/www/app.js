/* NoirPad — markdown notes that live as plain .md files inside the NOIR project.
 * Storage (same origin, served by `noir serve`):
 *   GET    /api/app-data/noirpad?list=1        -> { files: [{file,size,updated}] }
 *   GET    /api/app-data/noirpad?file=<rel>    -> { content }
 *   POST   /api/app-data/noirpad {file, content}
 *   DELETE /api/app-data/noirpad?file=<rel>
 * Notes: data/notes/<slug>.md with frontmatter (title/tags/updated).
 * Index: data/index.json (metadata cache for fast lists).
 * Because notes are plain files under .noir/webapps/noirpad/, the NOIR agent
 * can read and write them with its normal file tools.
 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const APP = "noirpad";
const API = `/api/app-data/${APP}`;

const state = {
  notes: [],        // [{slug, title, tags:[], updated, body}]
  current: null,    // slug being edited
  dirty: false,
  preview: false,
  saveTimer: null,
};

/* ---------------- utils ---------------- */

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add("hidden"), 2200);
}

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&" + "amp;"
    : ch === "<" ? "&" + "lt;"
    : ch === ">" ? "&" + "gt;"
    : ch === '"' ? "&" + "quot;"
    : "&" + "#39;"
  );

function slugify(title) {
  const base = (title || "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "note";
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

function relDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

/* tiny markdown -> html (input is escaped first, so it is safe) */
function mdToHtml(md) {
  const esc = escapeHtml(md);
  const blocks = esc.split(/\n{2,}/);
  return blocks
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (/^```/.test(t)) return `<pre><code>${t.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "")}</code></pre>`;
      const h = t.match(/^(#{1,3})\s+(.*)$/);
      if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      if (/^([-*]\s+)/.test(t)) return `<ul>${t.split("\n").map((l) => `<li>${inline(l.replace(/^([-*]\s+)/, ""))}</li>`).join("")}</ul>`;
      if (/^\d+\.\s+/.test(t)) return `<ol>${t.split("\n").map((l) => `<li>${inline(l.replace(/^\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
      if (/^>\s?/.test(t)) return `<blockquote>${inline(t.replace(/^>\s?/gm, ""))}</blockquote>`;
      if (/^---+$/.test(t)) return "<hr/>";
      return `<p>${inline(t).replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
}

/* ---------------- frontmatter ---------------- */

function serializeNote(note) {
  return (
    `---\ntitle: ${note.title.replace(/\n/g, " ")}\ntags: ${note.tags.join(", ")}\nupdated: ${note.updated}\n---\n\n` +
    note.body +
    (note.body.endsWith("\n") ? "" : "\n")
  );
}

function parseNote(file, content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-z]+):\s*(.*)$/i);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
    }
  }
  const body = (m ? m[2] : content).replace(/\r\n/g, "\n");
  const slug = file.split("/").pop().replace(/\.md$/, "");
  return {
    slug,
    title: meta.title || slug,
    tags: (meta.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
    updated: meta.updated || new Date().toISOString(),
    body: m ? m[2] : content,
    _body: body,
  };
}

/* ---------------- api ---------------- */

async function apiGet(params) {
  const res = await fetch(`${API}?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function apiWrite(file, content) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file, content }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function apiDelete(file) {
  const res = await fetch(`${API}?file=${encodeURIComponent(file)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/* ---------------- data ---------------- */

async function loadAll() {
  let index = { notes: [] };
  try {
    index = await apiGet({ file: "index.json" });
    index = JSON.parse(index.content || "{}");
  } catch {
    index = { notes: [] };
  }
  const listed = await apiGet({ list: "1" });
  const noteFiles = listed.files.filter((f) => f.file.startsWith("notes/") && f.file.endsWith(".md"));

  const loaded = await Promise.all(
    noteFiles.map(async (f) => {
      try {
        const r = await apiGet({ file: f.file });
        return parseNote(f.file, r.content);
      } catch {
        return null;
      }
    })
  );
  state.notes = loaded.filter(Boolean).sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  renderList();
}

async function persist(note) {
  note.updated = new Date().toISOString();
  await apiWrite(`notes/${note.slug}.md`, serializeNote(note));
  // maintain the metadata index
  let index = { notes: [] };
  try {
    index = JSON.parse((await apiGet({ file: "index.json" })).content || "{}");
  } catch {
    index = { notes: [] };
  }
  index.notes = (index.notes || []).filter((n) => n.slug !== note.slug);
  index.notes.unshift({ slug: note.slug, title: note.title, tags: note.tags, updated: note.updated });
  await apiWrite("index.json", JSON.stringify(index, null, 2));
}

/* ---------------- rendering ---------------- */

function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const list = $("#noteList");
  list.innerHTML = "";
  const visible = state.notes.filter((n) => {
    if (!q) return true;
    return n.title.toLowerCase().includes(q) || n.tags.join(" ").toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
  });
  if (!visible.length) {
    list.innerHTML = `<div class="empty">${state.notes.length ? "no notes match" : "no notes yet — tap ＋ NEW"}</div>`;
  }
  for (const n of visible) {
    const card = document.createElement("div");
    card.className = "note";
    const excerpt = n.body.replace(/^#{1,3}\s+.*$/gm, "").trim().slice(0, 140) || "(empty note)";
    card.innerHTML = `
      <div class="n-title">${escapeHtml(n.title)}</div>
      <div class="n-excerpt">${escapeHtml(excerpt)}</div>
      <div class="n-meta">
        ${n.tags.map((t) => `<span class="n-tag">${escapeHtml(t)}</span>`).join("")}
        <span class="n-date">${relDate(n.updated)}</span>
      </div>`;
    card.onclick = () => openNote(n.slug);
    list.append(card);
  }
  $("#storeInfo").textContent = `${state.notes.length} note(s) — stored as .md in .noir/webapps/${APP}/data/notes/`;
}

function openEditor(note) {
  state.current = note ? note.slug : null;
  $("#noteTitle").value = note ? note.title : "";
  $("#noteTags").value = note ? note.tags.join(", ") : "";
  $("#noteBody").value = note ? note.body : "";
  $("#saveState").textContent = note ? `editing ${note.slug}` : "new note";
  setPreview(false);
  $("#listView").classList.remove("active");
  $("#editorView").classList.add("active");
}

function closeEditor() {
  $("#editorView").classList.remove("active");
  $("#listView").classList.add("active");
  state.current = null;
  state.dirty = false;
  setPreview(false);
}

function setPreview(on) {
  state.preview = on;
  $("#preview").classList.toggle("hidden", !on);
  $("#noteBody").classList.toggle("hidden", on);
  $("#btnPreview").textContent = on ? "EDIT" : "PREVIEW";
  if (on) $("#preview").innerHTML = mdToHtml($("#noteBody").value || "(nothing to preview)");
}

function currentNoteFromForm() {
  const title = $("#noteTitle").value.trim() || "untitled";
  const tags = $("#noteTags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const body = $("#noteBody").value;
  const existing = state.notes.find((n) => n.slug === state.current);
  return {
    slug: state.current || slugify(title),
    title,
    tags,
    body,
    updated: existing ? existing.updated : new Date().toISOString(),
  };
}

async function saveNote(silent) {
  const note = currentNoteFromForm();
  try {
    await persist(note);
    const i = state.notes.findIndex((n) => n.slug === note.slug);
    if (i >= 0) state.notes[i] = note;
    else state.notes.unshift(note);
    state.notes.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    state.current = note.slug;
    state.dirty = false;
    $("#saveState").textContent = `saved ${new Date().toLocaleTimeString()} → notes/${note.slug}.md`;
    if (!silent) toast(`saved notes/${note.slug}.md`);
  } catch (err) {
    toast(`save failed: ${err.message}`);
  }
}

function scheduleAutosave() {
  state.dirty = true;
  $("#saveState").textContent = "unsaved changes…";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveNote(true), 900);
}

async function deleteNote() {
  if (!state.current) {
    closeEditor();
    return;
  }
  if (!confirm("Delete this note permanently?")) return;
  try {
    await apiDelete(`notes/${state.current}.md`);
    state.notes = state.notes.filter((n) => n.slug !== state.current);
    toast("deleted");
    closeEditor();
    renderList();
  } catch (err) {
    toast(`delete failed: ${err.message}`);
  }
}

function exportNote() {
  const note = currentNoteFromForm();
  const blob = new Blob([serializeNote(note)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${note.slug}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importFiles(files) {
  for (const file of files) {
    const text = await file.text();
    const note = parseNote(`notes/${file.name.replace(/\.md$/i, "")}.md`, text);
    note.slug = slugify(note.title);
    note.updated = new Date().toISOString();
    await persist(note);
    state.notes.unshift(note);
  }
  state.notes.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  renderList();
  toast(`imported ${files.length} note(s)`);
}

/* ---------------- boot ---------------- */

function boot() {
  $("#btnNew").onclick = () => openEditor(null);
  $("#btnBack").onclick = closeEditor;
  $("#btnSave").onclick = () => saveNote(false);
  $("#btnDelete").onclick = deleteNote;
  $("#btnExport").onclick = exportNote;
  $("#btnPreview").onclick = () => setPreview(!state.preview);
  $("#btnImport").onclick = () => $("#fileImport").click();
  $("#fileImport").onchange = (e) => {
    if (e.target.files.length) importFiles([...e.target.files]);
    e.target.value = "";
  };
  $("#search").oninput = renderList;
  $("#noteBody").oninput = scheduleAutosave;
  $("#noteTitle").oninput = scheduleAutosave;
  $("#noteTags").oninput = scheduleAutosave;
  $("#noteBody").onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      saveNote(false);
    }
  };
  loadAll().catch((err) => {
    $("#storeInfo").textContent = `storage unavailable: ${err.message}`;
    toast("cannot reach NOIR storage — is noir serve running?");
  });
}

boot();
