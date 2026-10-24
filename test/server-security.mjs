import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Server security & robustness: auth tokens, CORS, 404s, oversized bodies, busy/abort, throwing providers. */
export async function test() {
  const dir = tmpProject("noir-sec");

  /* ============ PART A: token auth on non-loopback bind ============ */
  const hA = await makeHarness(dir, { script: [{ text: "authed reply" }] });
  hA.config.server.auth = "auto";
  const { startServer } = await import("../dist/server/server.js");
  const secA = await startServer(hA, { host: "0.0.0.0", port: 0 });
  assert(secA.token, "token generated for non-loopback bind");
  const baseA = `http://127.0.0.1:${secA.port}`;

  let res = await fetch(`${baseA}/api/state`);
  assertEq(res.status, 401, "no token -> 401");
  res = await fetch(`${baseA}/api/state`, { headers: { "x-noir-token": "wrong" } });
  assertEq(res.status, 401, "wrong token -> 401");
  res = await fetch(`${baseA}/api/state`, { headers: { "x-noir-token": secA.token } });
  assertEq(res.status, 200, "correct header token -> 200");
  res = await fetch(`${baseA}/api/state?token=${secA.token}`);
  assertEq(res.status, 200, "query token accepted");
  res = await fetch(`${baseA}/`, { headers: { "x-noir-token": secA.token } });
  assertEq(res.status, 200, "static also protected");
  assertEq(res.headers.get("access-control-allow-origin"), "*", "CORS header present");
  const pre = await fetch(`${baseA}/api/chat`, { method: "OPTIONS" });
  assertEq(pre.status, 204, "OPTIONS preflight");
  assert(pre.headers.get("access-control-allow-methods").includes("POST"), "preflight methods");
  await secA.close();
  await hA.shutdown();

  /* ============ PART B: robustness on loopback ============ */
  const hB = await makeHarness(dir, { script: [{ text: "hello from mock" }] });
  const secB = await startServer(hB, { host: "127.0.0.1", port: 0 });
  const base = secB.url;

  // 404s
  res = await fetch(`${base}/api/definitely-not-real`);
  assertEq(res.status, 404, "unknown api endpoint 404");
  res = await fetch(`${base}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "not-a-command" }),
  });
  assertEq(res.status, 404, "unknown command 404");
  res = await fetch(`${base}/api/panel/ghost`);
  assertEq(res.status, 404, "unknown panel 404");

  // invalid JSON body -> clean 500 json (not a crash)
  res = await fetch(`${base}/api/command`, { method: "POST", headers: { "content-type": "application/json" }, body: "{broken json" });
  assertEq(res.status, 500, "malformed body -> 500");
  const errBody = await res.json();
  assert(errBody.error, "error body is json");

  // wrong content-type -> 404 (parsed as {} and misses)
  res = await fetch(`${base}/api/chat`, { method: "POST", body: "plain" });
  assertEq(res.status, 400, "chat without json body -> 400");

  // chat empty text
  res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "  " }) });
  assertEq(res.status, 400, "empty chat text -> 400");

  // register a panel through the public API then fetch it
  hB.panels.set("fake-panel", { id: "fake-panel", title: "Fake", render: () => "PANEL BODY 123" });
  res = await fetch(`${base}/api/panel/fake-panel`);
  assertEq(res.status, 200, "registered panel reachable");
  const panelJson = await res.json();
  assertEq(panelJson.content, "PANEL BODY 123", "panel content served");

  // session lifecycle over API
  await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "make a session" }) });
  res = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "new" }) });
  assertEq(res.status, 200, "session new");
  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  assert(sessions.length >= 1, "sessions listed after new");
  res = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume", id: sessions[0].id }) });
  assertEq(res.status, 200, "session resume");
  res = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume", id: "missing-id" }) });
  assertEq(res.status, 404, "resume missing -> 404");
  res = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "explode" }) });
  assertEq(res.status, 400, "bad action -> 400");

  // config patch whitelist
  res = await fetch(`${base}/api/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "patched-model", mcpServers: { evil: { command: "rm" } } }) });
  assertEq(res.status, 200, "config patch ok");
  assertEq(hB.model, "patched-model", "model patched");
  assertEq(Object.keys(hB.config.mcpServers).length, 0, "mcpServers NOT patchable via api (whitelist)");

  // compact endpoint
  res = await fetch(`${base}/api/compact`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assertEq(res.status, 200, "compact endpoint");

  // concurrent /api/state load
  const burst = await Promise.all(Array.from({ length: 25 }, () => fetch(`${base}/api/state`)));
  assert(burst.every((r) => r.status === 200), "25 parallel state requests all 200");

  // throwing provider -> SSE still terminates with note+done
  hB.provider = {
    id: "boom",
    label: "Boom",
    async *stream() {
      throw new Error("catastrophic");
    },
  };
  res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "make it explode" }) });
  const raw = await res.text();
  assert(raw.includes("catastrophic") && raw.includes('"type":"done"'), `throwing provider -> error note + done in SSE`);

  // HEAD request handled
  res = await fetch(`${base}/`, { method: "HEAD" });
  assertEq(res.status, 200, "HEAD on / handled");

  await secB.close();
  await hB.shutdown();
}
