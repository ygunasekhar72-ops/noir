/* NOIR web app — vanilla JS, monochrome, mobile-first. Talks to the local harness server. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  busy: false,
  provider: "",
  model: "",
  presets: {},
  panels: [],
  commands: [],
  sessions: [],
};

/* ------------------------------------------------------------------ utils */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(await res.text()).slice(0, 300)}`);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : res.text();
}

/** POST + parse an SSE stream of {data: {...}} events. */
async function stream(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* skip malformed */
        }
      }
    }
  }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setBusy(busy) {
  state.busy = busy;
  $("#btnAbort").classList.toggle("hidden", !busy);
  $("#hdrMeta").classList.toggle("busy", busy);
  $("#btnSend").disabled = busy;
}

/* ------------------------------------------------------------------ views */

const VIEWS = [
  { id: "chat", label: "CHAT", glyph: "◧" },
  { id: "terminal", label: "TERM", glyph: "▤" },
  { id: "memory", label: "MEM", glyph: "◫" },
  { id: "skills", label: "SKILL", glyph: "◨" },
  { id: "agents", label: "SWARM", glyph: "◍" },
  { id: "settings", label: "CONF", glyph: "◎" },
];

function buildTabs() {
  const nav = $("#tabs");
  nav.innerHTML = "";
  for (const v of VIEWS) {
    const b = el("button", "", "");
    b.dataset.view = v.id;
    b.append(el("span", "glyph", v.glyph), el("span", "", v.label));
    b.onclick = () => showView(v.id);
    nav.append(b);
  }
}

function showView(id) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${id}`));
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
  if (id === "memory") loadMemory();
  if (id === "skills") loadSkills();
  if (id === "settings") loadSettings();
  if (id === "agents") loadAgents();
}

/* ------------------------------------------------------------------ chat */

function addMsg(kind, text) {
  const m = el("div", `msg ${kind}`);
  const who = el("div", "who", kind === "user" ? "❯ YOU" : kind === "assistant" ? "◆ NOIR" : "· SYSTEM");
  const b = el("div", "bubble");
  b.textContent = text;
  m.append(who, b);
  $("#messages").append(m);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return b;
}

function addChip(text, err) {
  const c = el("div", "toolchip" + (err ? " err" : ""), text);
  $("#messages").append(c);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return c;
}

let abortCtl = null;

async function send(textOverride) {
  const input = $("#input");
  const text = (textOverride ?? input.value).trim();
  if (!text || state.busy) return;
  if (text.startsWith("/")) {
    addMsg("user", text);
    input.value = "";
    await runCommand(text);
    return;
  }
  if (text.startsWith("!")) {
    addMsg("user", text);
    input.value = "";
    await runTerminal(text.slice(1), true);
    return;
  }
  input.value = "";
  autoGrow(input);
  addMsg("user", text);
  setBusy(true);
  abortCtl = new AbortController();
  let bubble = null;
  let acc = "";
  try {
    await stream("/api/chat", { text }, (ev) => {
      if (ev.type === "delta") {
        acc += ev.text;
        if (!bubble) bubble = addMsg("assistant", "");
        bubble.textContent = acc;
        $("#messages").scrollTop = $("#messages").scrollHeight;
      } else if (ev.type === "tool") {
        if (ev.phase === "start") addChip(`▸ ${ev.name} ${JSON.stringify(ev.args ?? {}).slice(0, 100)}`);
        else addChip(`  ↳ ${(ev.result ?? "").split("\n").slice(0, 3).join(" ⏎ ").slice(0, 180)}`, !ev.ok);
      } else if (ev.type === "compaction") {
        addMsg("system", `· compaction ${ev.phase}${ev.detail ? " — " + ev.detail : ""}`);
      } else if (ev.type === "note") {
        addMsg("system", ev.text);
      } else if (ev.type === "done") {
        if (!acc) addMsg("system", ev.reason === "aborted" ? "· aborted" : "· done");
      }
    }, abortCtl.signal);
  } catch (err) {
    if (err.name !== "AbortError") addMsg("system", `error: ${err.message}`);
  } finally {
    setBusy(false);
    abortCtl = null;
    refreshState();
  }
}

async function runCommand(text) {
  const parts = text.slice(1).split(/\s+/);
  const name = parts[0];
  const args = parts.slice(1);
  try {
    const r = await api("/api/command", { method: "POST", body: JSON.stringify({ name, args }) });
    addMsg("assistant", r.output ?? JSON.stringify(r));
  } catch (err) {
    addMsg("system", `error: ${err.message}`);
  }
}

/* command palette */
function openPalette(prefill) {
  const p = $("#palette");
  p.classList.remove("hidden");
  const inp = $("#paletteInput");
  inp.value = prefill ?? "/";
  renderPaletteList("/");
  inp.focus();
}

function renderPaletteList(filter) {
  const list = $("#paletteList");
  list.innerHTML = "";
  const cmds = state.commands.filter((c) => c.name.includes(filter.replace(/^\//, "")));
  for (const c of cmds.slice(0, 30)) {
    const item = el("div", "item");
    item.append(el("div", "itemTitle", `/${c.name}`), el("div", "itemSub", c.description));
    item.onclick = () => {
      $("#palette").classList.add("hidden");
      const inp = $("#input");
      inp.value = `/${c.name} `;
      inp.focus();
    };
    list.append(item);
  }
}

/* ------------------------------------------------------------------ terminal */

async function runTerminal(command, intoChat) {
  const target = intoChat ? null : $("#termOut");
  const write = (t) => {
    if (target) {
      target.textContent += t;
      target.scrollTop = target.scrollHeight;
    }
  };
  if (!intoChat) {
    target.textContent += `\n$ ${command}\n`;
    $("#termRun").disabled = true;
  } else {
    addChip(`◆ shell: ${command}`);
  }
  try {
    await stream("/api/terminal", { command }, (ev) => {
      if (ev.type === "out") {
        if (intoChat) addChip(ev.v.split("\n").slice(0, 6).join(" ⏎ ").slice(0, 400));
        else write(ev.v);
      } else if (ev.type === "exit") {
        if (intoChat) addChip(`  ↳ [exit ${ev.code}]`);
        else write(`\n[exit ${ev.code}]\n`);
      }
    });
  } catch (err) {
    write(`error: ${err.message}\n`);
  } finally {
    if (!intoChat) $("#termRun").disabled = false;
  }
}

/* ------------------------------------------------------------------ memory */

async function loadMemory() {
  try {
    const m = await api("/api/memory");
    $("#memNotes").textContent = m.notes || "(empty — the agent fills this via save_memory)";
    $("#memFacts").textContent = m.facts || "(empty)";
    const snaps = el("div", "list");
    if (!m.snapshots.length) snaps.append(el("div", "itemSub", "no snapshots yet — written before every compaction"));
    for (const s of m.snapshots.slice(0, 12)) {
      snaps.append(el("div", "itemSub", `${s.file} — ${(s.size / 1024).toFixed(1)}KB`));
    }
    $("#memSnapshots").replaceChildren(snaps);
  } catch (err) {
    toast(err.message);
  }
}

/* ------------------------------------------------------------------ skills */

async function loadSkills() {
  const box = $("#skillsList");
  box.replaceChildren(el("div", "itemSub", "(loading…)"));
  try {
    const st = await api("/api/state");
    box.innerHTML = "";
    if (!st.skills.length) box.append(el("div", "itemSub", "no skills installed — add .noir/skills/<name>/SKILL.md"));
    for (const s of st.skills) {
      const item = el("div", "item");
      item.append(el("div", "itemTitle", s.id), el("div", "itemSub", s.description || "(no description)"));
      const row = el("div", "row");
      const run = el("button", "btn", "ACTIVATE");
      run.onclick = () => {
        showView("chat");
        send(`/skill ${s.id}`);
      };
      row.append(run);
      item.append(row);
      box.append(item);
    }
  } catch (err) {
    box.replaceChildren(el("div", "itemSub", err.message));
  }
}

/* ------------------------------------------------------------------ agents */

async function loadAgents() {
  try {
    const st = await api("/api/state");
    const sel = $("#agentType");
    if (!sel.options.length) {
      for (const a of st.agents) sel.append(new Option(`${a.name} — ${a.description.slice(0, 40)}`, a.name));
    }
  } catch (err) {
    toast(err.message);
  }
}

async function runSubagent() {
  const out = $("#agentOut");
  out.classList.remove("hidden");
  out.textContent = "running…\n";
  $("#agentRun").disabled = true;
  try {
    await stream("/api/subagent", { agent: $("#agentType").value, task: $("#agentTask").value }, (ev) => {
      if (ev.type === "start") out.textContent = ev.text + "\n";
      if (ev.type === "result") out.textContent = (ev.error ? `failed: ${ev.error}` : ev.text) + "\n";
    });
  } catch (err) {
    out.textContent += `error: ${err.message}\n`;
  } finally {
    $("#agentRun").disabled = false;
  }
}

async function runSwarm() {
  const out = $("#swarmOut");
  out.classList.remove("hidden");
  out.textContent = "planning…\n";
  $("#swarmRun").disabled = true;
  try {
    await stream("/api/swarm", { objective: $("#swarmObjective").value }, (ev) => {
      if (ev.type === "swarm") out.textContent += `· ${ev.phase}${ev.detail ? ": " + ev.detail : ""}\n`;
      if (ev.type === "result") out.textContent += "\n" + ev.text + "\n";
      if (ev.type === "error") out.textContent += `error: ${ev.text}\n`;
      out.scrollTop = out.scrollHeight;
    });
  } catch (err) {
    out.textContent += `error: ${err.message}\n`;
  } finally {
    $("#swarmRun").disabled = false;
  }
}

/* ------------------------------------------------------------------ settings */

async function loadSettings() {
  try {
    const st = await api("/api/state");
    const cfg = await api("/api/config");
    state.presets = st.presets ?? {};
    const sel = $("#setProvider");
    sel.innerHTML = "";
    for (const [id, p] of Object.entries(state.presets)) sel.append(new Option(`${id} — ${p.label}`, id));
    sel.value = st.provider;
    $("#setModel").value = st.model;
    $("#setInfo").textContent =
      `project: ${st.projectDir}\nsession: ${st.session.id} (${st.session.messages} msgs)\n` +
      `provider ready: ${st.providerReady}${st.providerError ? `\nerror: ${st.providerError}` : ""}\n` +
      `search: ${st.search} · mcp servers: ${st.mcp.length} · compact at ${cfg.compactAtTokens} tok`;
    loadSessions();
    $("#registryInfo").textContent =
      `tools (${st.tools.length}): ${st.tools.join(", ")}\n\npanels: ${st.panels.map((p) => p.id).join(", ") || "none"}\n` +
      `extensions+plugin commands: ${st.commands.filter((c) => !CORE_CMDS.includes(c.name)).map((c) => "/" + c.name).join(", ") || "none"}`;
  } catch (err) {
    toast(err.message);
  }
}

const CORE_CMDS = [
  "help", "model", "provider", "compact", "clear", "sessions", "resume", "skills", "skill",
  "plugins", "extensions", "mcp", "memory", "agent", "swarm", "doctor", "exit",
];

async function saveSettings() {
  try {
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify({ provider: $("#setProvider").value, model: $("#setModel").value, apiKey: $("#setApiKey").value || undefined }),
    });
    toast("saved — provider reloaded");
    $("#setApiKey").value = "";
    refreshState();
    loadSettings();
  } catch (err) {
    toast(err.message);
  }
}

async function loadSessions() {
  try {
    const list = await api("/api/sessions");
    state.sessions = list;
    const box = $("#sessionsList");
    box.innerHTML = "";
    if (!list.length) box.append(el("div", "itemSub", "no sessions yet"));
    for (const s of list.slice(0, 12)) {
      const item = el("div", "item");
      item.append(el("div", "itemTitle", s.title || s.id), el("div", "itemSub", `${s.id} · ${s.messageCount} msgs · ${s.tokens} tok`));
      const row = el("div", "row");
      const resume = el("button", "btn", "RESUME");
      resume.onclick = async () => {
        await api("/api/session", { method: "POST", body: JSON.stringify({ action: "resume", id: s.id }) });
        toast(`resumed ${s.id}`);
        $("#messages").innerHTML = "";
        addMsg("system", `resumed session ${s.id} — context restored`);
      };
      row.append(resume);
      item.append(row);
      box.append(item);
    }
  } catch (err) {
    toast(err.message);
  }
}

/* ------------------------------------------------------------------ state */

async function refreshState() {
  try {
    const st = await api("/api/state");
    state.commands = st.commands;
    state.panels = st.panels;
    state.provider = st.provider;
    state.model = st.model;
    $("#hdrMeta").textContent = `${st.provider}/${st.model} · ${st.session.tokens} tok · ${st.projectDir.split(/[\\/]/).pop()}`;
    // extension panels -> extra views (once)
    for (const p of st.panels) {
      if (VIEWS.some((v) => v.id === p.id)) continue;
      VIEWS.push({ id: p.id, label: p.title.toUpperCase().slice(0, 6), glyph: "▤" });
      const sec = el("section", "view");
      sec.id = `view-${p.id}`;
      sec.append(el("div", "card", ""), (() => { const c = el("div", "card"); const t = el("div", "cardTitle", p.title.toUpperCase()); const pre = el("pre", "pre", "(tap to load)"); c.append(t, pre); return c; })());
      $("#main").append(sec);
      buildTabs();
    }
    setBusy(st.busy);
  } catch {
    $("#hdrMeta").textContent = "offline — is `noir serve` running?";
  }
}

async function loadPanelView(id) {
  try {
    const r = await api(`/api/panel/${encodeURIComponent(id)}`);
    const sec = $(`#view-${id}`);
    sec.querySelector("pre").textContent = r.content;
  } catch (err) {
    toast(err.message);
  }
}

/* ------------------------------------------------------------------ boot */

function autoGrow(t) {
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.3) + "px";
}

function boot() {
  buildTabs();
  $("#btnSend").onclick = () => send();
  $("#btnAbort").onclick = () => abortCtl?.abort();
  $("#btnCompact").onclick = async () => {
    toast("compacting (snapshot first)…");
    const r = await api("/api/compact", { method: "POST", body: "{}" });
    toast(r.ok ? "compacted" : `failed: ${r.detail}`);
  };
  $("#termRun").onclick = () => {
    const c = $("#termInput").value.trim();
    if (c) {
      $("#termInput").value = "";
      runTerminal(c, false);
    }
  };
  $("#termInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#termRun").click();
    }
  });
  $("#agentRun").onclick = runSubagent;
  $("#swarmRun").onclick = runSwarm;
  $("#setSave").onclick = saveSettings;
  $("#newSession").onclick = async () => {
    await api("/api/session", { method: "POST", body: JSON.stringify({ action: "new" }) });
    $("#messages").innerHTML = "";
    addMsg("system", "new session — memory workspace still loaded");
    loadSessions();
  };
  $("#refreshSessions").onclick = loadSessions;

  const input = $("#input");
  input.addEventListener("input", () => autoGrow(input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("keyup", () => {
    const v = input.value;
    if (v.startsWith("/") && !v.includes(" ")) openPalette(v);
    else $("#palette").classList.add("hidden");
  });

  $("#paletteInput").addEventListener("input", (e) => renderPaletteList(e.target.value));
  $("#palette").addEventListener("click", (e) => {
    if (e.target.id === "palette") $("#palette").classList.add("hidden");
  });

  showView("chat");
  refreshState();
  setInterval(refreshState, 15000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

boot();
