// End-to-end check for the graph: node dragging, click kick, hover focus, pan, zoom.
// Drives headless Chrome over CDP. No dependencies - `node test.mjs`.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8781, DEBUG_PORT = 9335;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(join(HERE, "index.html")));
}).listen(PORT);

const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "graph-test-"))}`,
    "--no-first-run", "--no-default-browser-check",
    `http://localhost:${PORT}/`,
], { stdio: "ignore" });

let ws, id = 0;
const pending = new Map();
function send(method, params = {}) {
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise(res => pending.set(msgId, res));
}

async function attach() {
    for (let i = 0; i < 40; i++) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
            const page = targets.find(t => t.type === "page" && t.url.includes(String(PORT)));
            if (page) {
                ws = new WebSocket(page.webSocketDebuggerUrl);
                ws.addEventListener("message", e => {
                    const m = JSON.parse(e.data);
                    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
                });
                await new Promise(r => ws.addEventListener("open", r, { once: true }));
                return;
            }
        } catch { /* chrome not up yet */ }
        await sleep(250);
    }
    throw new Error("could not attach to Chrome - is it installed at " + CHROME + "?");
}

async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
}

const mouse = (type, x, y) => send("Input.dispatchMouseEvent", {
    type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1,
});
const hover = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });

const positions = () => evaluate(`
    [...document.querySelectorAll('.node-circle')].map(c => {
        const box = c.getBoundingClientRect();
        return { x: +c.getAttribute('cx'), y: +c.getAttribute('cy'),
                 sx: box.x + box.width / 2, sy: box.y + box.height / 2 };
    })`);

function check(label, ok, detail = "") {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
    if (!ok) process.exitCode = 1;
}

try {
    await attach();
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2500); // let the simulation settle

    const settled = await positions();
    const radii = settled.slice(1).map(n => Math.hypot(n.x - 500, n.y - 500));
    check("layout settles into a ring", Math.min(...radii) > 200 && Math.max(...radii) < 460,
        `radius ${Math.min(...radii).toFixed(0)}..${Math.max(...radii).toFixed(0)}`);
    check("source node stays centred", Math.hypot(settled[0].x - 500, settled[0].y - 500) < 20);
    check("edges track live node positions", await evaluate(
        `(() => { const line = document.querySelector('.edge'), c = document.querySelectorAll('.node-circle');
          return Math.abs(+line.getAttribute('x1') - +c[0].getAttribute('cx')) < 0.01; })()`));

    const target = settled[3];
    await mouse("mousePressed", target.sx, target.sy);
    for (let i = 1; i <= 12; i++) {
        await mouse("mouseMoved", target.sx + i * 10, target.sy + i * 6);
        await sleep(16);
    }
    const dragging = await positions();
    const followed = Math.hypot(dragging[3].x - target.x, dragging[3].y - target.y);
    check("dragged node follows the pointer", followed > 80, `moved ${followed.toFixed(0)} units`);
    const shifts = dragging.map((p, i) => i === 3 ? 0 : Math.hypot(p.x - settled[i].x, p.y - settled[i].y));
    check("the rest of the graph reacts to a drag", Math.max(...shifts) > 3,
        `largest neighbour shift ${Math.max(...shifts).toFixed(1)} units`);
    check("a drag does not follow the link", await evaluate(
        `(() => { const a = document.querySelectorAll('.node')[3];
          let navigated = true; a.addEventListener('click', e => { navigated = !e.defaultPrevented; }, { once: true });
          a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return !navigated; })()`));

    await mouse("mouseReleased", target.sx + 120, target.sy + 72);
    await sleep(3000);
    const released = await positions();
    const relaxed = Math.hypot(released[3].x - 500, released[3].y - 500);
    check("released node relaxes back into the layout", relaxed > 200 && relaxed < 460, `radius ${relaxed.toFixed(0)}`);
    check("no NaN positions", released.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));

    // Links are defanged first so the click does not open a real tab.
    await evaluate(`document.querySelectorAll('.node').forEach(a => { a.removeAttribute('target'); a.setAttribute('href', '#'); })`);
    const before = await positions();
    await mouse("mousePressed", before[5].sx, before[5].sy);
    await mouse("mouseReleased", before[5].sx, before[5].sy);
    await sleep(400);
    const kicked = await positions();
    const kick = Math.hypot(kicked[5].x - before[5].x, kicked[5].y - before[5].y);
    check("a plain click visibly moves the node", kick > 10, `moved ${kick.toFixed(0)} units`);

    await sleep(3000);
    const hovered = (await positions())[5];
    await hover(hovered.sx, hovered.sy);
    await sleep(150);
    check("hovering dims everything unrelated", await evaluate(
        `document.getElementById('graph').classList.contains('dim') &&
         document.querySelectorAll('.node.hl').length === 2`));
    await hover(5, 5);
    await sleep(150);
    check("dimming clears on leave", await evaluate(`!document.getElementById('graph').classList.contains('dim')`));

    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 450, deltaX: 0, deltaY: -240, buttons: 0 });
    await sleep(150);
    const zoomed = await evaluate(`document.getElementById('view').getAttribute('transform')`);
    check("the wheel zooms the camera", /scale\((?!1\))/.test(zoomed), zoomed);

    await mouse("mousePressed", 30, 30);
    await mouse("mouseMoved", 130, 90);
    await mouse("mouseReleased", 130, 90);
    await sleep(150);
    const panned = await evaluate(`document.getElementById('view').getAttribute('transform')`);
    check("dragging the background pans the camera", panned !== zoomed, panned);
} finally {
    ws?.close();
    chrome.kill();
    server.close();
}
