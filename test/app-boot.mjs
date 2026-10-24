/**
 * LIVE App boot test: renders the REAL TUI App (the actual application
 * component, not mocked), types through the fake stdin, and verifies:
 * boot chrome → slash command execution → chat turn with reply → panel
 * switching. This is the closest thing to a human driving the TUI.
 */
import { Writable, PassThrough } from "node:stream";
import React from "react";

delete process.env.CI;
delete process.env.TERM;

function makeStdout() {
  const s = new Writable({
    write(chunk, _enc, cb) {
      s.output += chunk.toString();
      cb();
    },
  });
  s.output = "";
  s.columns = 120;
  s.rows = 40;
  s.isTTY = true;
  return s;
}
function makeStdin() {
  const s = new PassThrough();
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}
const stripAnsi = (t) =>
  t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b[=>]/g, "");

export async function test() {
  const { tmpProject, makeHarness } = await import("./helpers.mjs");
  const harness = await makeHarness(tmpProject("noir-app-boot"), { script: [{ text: "mock reply ok" }] });

  const { render } = await import("ink");
  const { TuiApp } = await import("../dist/tui/app.js");

  const stdout = makeStdout();
  const stdin = makeStdin();
  const instance = render(React.createElement(TuiApp, { harness, serverUrlRef: { current: null } }), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (needle, timeout = 8000) => {
    const t0 = Date.now();
    while (!stripAnsi(stdout.output).includes(needle)) {
      if (Date.now() - t0 > timeout) return false;
      await wait(50);
    }
    return true;
  };

  // let the app fully boot and attach its input readers (like a human would)
  await wait(500);
  const frame1 = stripAnsi(stdout.output);
  assert(frame1.includes("NOIR"), "boot: brand rendered");
  assert(frame1.includes("mock-model"), "boot: header shows model");
  assert(frame1.includes("CHAT"), "boot: footer tabs rendered");
  assert(frame1.includes("task, /command or !shell"), "boot: composer placeholder");

  // type like a keyboard: chars separately, then enter
  const type = async (text) => {
    for (const ch of text) {
      stdin.write(ch);
      await wait(12);
    }
    await wait(80);
    stdin.write("\r");
  };

  // slash command: /help output uniquely contains "/exit"
  await type("/help");
  assert(await waitFor("/exit"), "slash command executed (/help output rendered)");

  // chat turn: mock provider replies
  await type("say something");
  assert(await waitFor("mock reply ok"), "chat turn: user input + provider reply rendered");
  // shell passthrough: runs and completes (wait for the exit marker, not the echo)
  await type("!node -e \"console.log('shell-echo-appboot')\"");
  assert(await waitFor("shell-echo-appboot", 15000), "shell output rendered");
  assert(await waitFor("[exit 0]", 15000), "shell command completed");

  // tab -> TERMINAL panel
  stdin.write("\t");
  assert(await waitFor("TERMINAL — commands run in the project dir"), "tab switches to terminal panel");

  instance.unmount();
  await wait(50);
  await harness.shutdown();
}

import { assert } from "./helpers.mjs";
