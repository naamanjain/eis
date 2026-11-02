#!/usr/bin/env node
'use strict';
/* Trusted-input layout probe for the extension webview. Dev-only: tools/** is excluded
 * from the .vsix by .vscodeignore.
 *
 *   node tools/preview/probe.js            # gates + screenshots, non-zero exit on failure
 *
 * Why this exists next to the real-window suite: inside VS Code the suite can move a
 * scroller with `scrollTop`, which proves the element is a scroll container but NOT that
 * a wheel gesture reaches it. Synthetic WheelEvents never scroll anything in Chrome, so
 * the only honest answer comes from CDP `Input.dispatchMouseEvent{type:'mouseWheel'}`,
 * which is trusted input. Screenshots land in the OS temp dir.
 *
 * Zero installs: Node's global WebSocket drives Chrome's own DevTools protocol.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// Everything here depends on Node's global WebSocket, which arrived in Node 21. `engines`
// says >=18.17 because nothing that ships in the .vsix needs more than that, so this
// development-only tool states its own requirement instead of failing mid-run with
// "WebSocket is not defined".
if (typeof globalThis.WebSocket !== 'function') {
  console.error(`check:layout needs Node 21+ for the global WebSocket that drives CDP; this is Node ${process.version}.`);
  process.exit(2);
}

const PORT = Number(process.env.EIS_PROBE_PORT || 8932);
const CDP_PORT = Number(process.env.EIS_CDP_PORT || 9333);
const OUT = path.join(os.tmpdir(), 'eis-layout-probe');
const CHROME = process.env.EIS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Geometry measured inside a real VS Code window on this machine.
const SURFACES = [
  { name: 'rail', width: 297, height: 662 },
  { name: 'panel', width: 712, height: 670 },
];
const SCREENS = ['setup', 'main'];
// EIS_PROBE_LIVE=1 replays a captured live model response, so the screenshots and the
// wheel test run against a populated picker rather than the three curated ids.
const SUFFIX = process.env.EIS_PROBE_LIVE === '1' ? '&live=1' : '';
const WHEEL_STEPS = 3;
const WHEEL_DELTA = 160;

function findChrome() {
  if (fs.existsSync(CHROME)) return CHROME;
  const fallbacks = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  return fallbacks.find((candidate) => fs.existsSync(candidate)) || null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`${url} is not JSON: ${text.slice(0, 120)}`));
        }
      });
    }).on('error', reject);
  });
}

// Readiness only needs an answer, not a parseable body — the preview server serves
// JavaScript at /data.js, which is not JSON.
function isUp(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1500, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitFor(url, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      return await getJson(url);
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function waitUntilUp(url, timeoutMs) {
  const started = Date.now();
  for (;;) {
    if (await isUp(url)) return true;
    if (Date.now() - started > timeoutMs) throw new Error(`nothing answered on ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Minimal CDP client over the browser websocket, one flat session per target. */
function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')));
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
      else resolve(message.result);
    }
  });

  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      try {
        socket.close();
      } catch (error) {
        /* already gone */
      }
    },
  };
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`page script threw: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result.value;
}

const MEASURE = `(function () {
  var scroller = document.querySelector('.screen[data-active="true"] .scroll');
  var rect = scroller ? scroller.getBoundingClientRect() : null;
  return JSON.stringify({
    innerH: innerHeight, innerW: innerWidth,
    docScrollH: document.documentElement.scrollHeight,
    bodyScrollH: document.body.scrollHeight,
    appClientH: document.getElementById('app').clientHeight,
    scroller: scroller ? {
      clientH: scroller.clientHeight, scrollH: scroller.scrollHeight,
      clientW: scroller.clientWidth, scrollW: scroller.scrollWidth,
      top: rect.top, left: rect.left, width: rect.width, height: rect.height,
      scrollTop: scroller.scrollTop,
    } : null,
  });
})()`;

async function probeSurface(client, sessionId, surface, screen) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: surface.width, height: surface.height, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await client.send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/frame.html?screen=${screen}&width=${surface.width}${SUFFIX}`,
  }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 900));

  const before = JSON.parse(await evaluate(client, sessionId, MEASURE));
  const notes = [];
  const failures = [];

  if (before.bodyScrollH > before.innerH + 2) {
    failures.push(`document is ${before.bodyScrollH}px in a ${before.innerH}px viewport; body clips it`);
  }
  if (before.appClientH > before.innerH + 2) {
    failures.push(`#app is ${before.appClientH}px, taller than the viewport`);
  }
  const scroller = before.scroller;
  if (!scroller) {
    failures.push('the active screen has no .scroll element');
    return { before, notes, failures };
  }
  if (scroller.scrollW > scroller.clientW + 1) {
    failures.push(`content is ${scroller.scrollW}px wide in a ${scroller.clientW}px column (horizontal clipping)`);
  }

  const overflows = scroller.scrollH > scroller.clientH + 4;
  if (!overflows) {
    notes.push(`fits without scrolling (${scroller.scrollH}/${scroller.clientH})`);
  } else {
    // Trusted wheel input at the centre of the scroller. Synthetic WheelEvents never
    // scroll in Chrome, so this is the only gesture that answers the question.
    const x = Math.round(scroller.left + scroller.width / 2);
    const y = Math.round(scroller.top + Math.min(scroller.height / 2, 200));
    for (let i = 0; i < WHEEL_STEPS; i++) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: WHEEL_DELTA }, sessionId);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const after = JSON.parse(await evaluate(client, sessionId, MEASURE));
    const moved = after.scroller.scrollTop - scroller.scrollTop;
    const overflow = scroller.scrollH - scroller.clientH;
    const expected = Math.min(WHEEL_STEPS * WHEEL_DELTA, overflow);
    notes.push(`wheel ${WHEEL_STEPS}x${WHEEL_DELTA} at ${x},${y} moved scrollTop ${moved}px of ${overflow}px overflow`);
    // The bar is what the gesture could achieve, not a fixed number: a screen that only
    // overflows 31px cannot move 480px, and calling that a failure would be the gate
    // lying about the product.
    if (moved < expected - 2) {
      failures.push(`the wheel moved ${moved}px where ${expected}px was available`);
    }
    if (after.bodyScrollH > after.innerH + 2) failures.push('wheeling pushed the document past the viewport');
  }

  const shot = path.join(OUT, `${surface.name}-${screen}.png`);
  const image = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(shot, Buffer.from(image.data, 'base64'));
  notes.push(`screenshot ${shot}`);
  return { before, notes, failures };
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('EISFAIL probe :: no Chrome or Edge found (set EIS_CHROME)');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js')], {
    env: { ...process.env, EIS_PREVIEW_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (chunk) => console.log(`EISNOTE server :: ${String(chunk).trim()}`));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'eis-cdp-profile')}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browser.stderr.on('data', () => {});

  let failures = 0;
  let client;
  try {
    await waitUntilUp(`http://127.0.0.1:${PORT}/frame.html?screen=setup`, 15000);
    const version = await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, 20000);
    client = connect(version.webSocketDebuggerUrl);
    await client.ready;
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);

    for (const surface of SURFACES) {
      for (const screen of SCREENS) {
        const label = `${surface.name} ${screen} (${surface.width}x${surface.height})`;
        try {
          const result = await probeSurface(client, sessionId, surface, screen);
          for (const note of result.notes) console.log(`EISNOTE ${label} :: ${note}`);
          if (result.failures.length) {
            failures += 1;
            for (const failure of result.failures) console.log(`EISFAIL ${label} :: ${failure}`);
          } else {
            console.log(`EISPASS ${label}`);
          }
        } catch (error) {
          failures += 1;
          console.log(`EISFAIL ${label} :: ${error.message}`);
        }
      }
    }
  } catch (error) {
    failures += 1;
    console.log(`EISFAIL probe :: ${error.message}`);
  } finally {
    if (client) client.close();
    for (const child of [browser, server]) {
      try {
        process.kill(-child.pid);
      } catch (error) {
        try {
          child.kill();
        } catch (gone) { /* already exited */ }
      }
    }
  }
  console.log(`${failures ? 'EISRESULT FAIL' : 'EISRESULT PASS'} failures=${failures}`);
  process.exitCode = failures ? 1 : 0;
}

main();
