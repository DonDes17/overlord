// Regenerates every logo asset (favicons, desktop app icons, README images) from the geometry below.
//
//   npx electron scripts/build-logo.cjs
//
// Electron is only used as an SVG rasteriser (it is already a dependency). macOS is needed for icon.icns
// (iconutil); everywhere else that file is left untouched.
//
// The mark: one origin (the orchestrator, with a halo) feeding three workspaces (rounded squares).
// Three drawings of it, because a detail that works at 512 px is mush at 16 px:
//   - master: halo and slim strokes, for 64 px and up;
//   - small:  no halo, heavier strokes and shapes, for 16 to 48 px.
// And three frames: the macOS icon (squircle with a margin), flat (the same squircle edge to edge, for
// favicons and Windows) and square (no rounding, for iOS and the docs, which round it themselves).
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.setPath("userData", path.join(os.tmpdir(), "overlord-logo-ud"));
app.disableHardwareAcceleration();

const root = path.resolve(__dirname, "..");
const ACCENT = "#72B8F2";
const LIGHT = "#EAF4FF";

const MASTER = { ox: 300, orad: 80, halo: true, sx: 740, size: 104, rx: 30, ys: [322, 512, 702], stroke: 28, start: 372 };
const SMALL = { ox: 300, orad: 104, halo: false, sx: 736, size: 136, rx: 36, ys: [312, 512, 712], stroke: 46, start: 380 };

function glyph(g) {
  const parts = [];
  for (const y of g.ys) {
    parts.push(
      `<path d="M ${g.start} 512 C 540 512, 530 ${y}, ${g.sx - g.size / 2} ${y}" fill="none" stroke="${ACCENT}" stroke-width="${g.stroke}" stroke-linecap="round"/>`,
      `<rect x="${g.sx - g.size / 2}" y="${y - g.size / 2}" width="${g.size}" height="${g.size}" rx="${g.rx}" fill="${ACCENT}"/>`
    );
  }
  if (g.halo) {
    parts.push(`<circle cx="${g.ox}" cy="512" r="${g.orad + 38}" fill="none" stroke="${LIGHT}" stroke-opacity="0.28" stroke-width="10"/>`);
  }
  parts.push(`<circle cx="${g.ox}" cy="512" r="${g.orad}" fill="${LIGHT}"/>`);
  return parts.join("\n  ");
}

const BG_DEFS = `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#161C25"/><stop offset="1" stop-color="#0B0E13"/></linearGradient></defs>`;

function svg(frame, g) {
  const body = glyph(g);
  if (frame === "icon") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${BG_DEFS}
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <rect x="103" y="103" width="818" height="818" rx="182" fill="none" stroke="#FFFFFF" stroke-opacity="0.07" stroke-width="6"/>
  ${body}
</svg>`;
  }
  const rx = frame === "square" ? 0 : 185;
  const edge = frame === "square" ? "" : `<rect x="103" y="103" width="818" height="818" rx="182" fill="none" stroke="#FFFFFF" stroke-opacity="0.07" stroke-width="6"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 100 824 824">${BG_DEFS}
  <rect x="100" y="100" width="824" height="824" rx="${rx}" fill="url(#bg)"/>
  ${edge}
  ${body}
</svg>`;
}

// The mark alone, no frame (banner, wide tiles).
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="147 212 680 600">${glyph(MASTER)}</svg>`;

// Which drawing for a given size.
const flatFor = (size) => svg("flat", size <= 48 ? SMALL : MASTER);

// One window for the whole run (creating and destroying one per image is not reliable offscreen), large
// enough for the biggest image; each image is a screenshot of its own rectangle.
let win;
async function page(html, w, h, afterLoad = "") {
  if (!win) {
    win = new BrowserWindow({ width: 1100, height: 1100, useContentSize: true, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<body></body>"));
  }
  await win.webContents.executeJavaScript(`(async () => {
    document.body.style.cssText = "margin:0;background:transparent";
    document.body.innerHTML = ${JSON.stringify(html)};
    await Promise.all([...document.images].map((i) => i.decode()));
    await document.fonts.ready;
    ${afterLoad}
  })()`);
  await new Promise((r) => setTimeout(r, 120));
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  const size = image.getSize();
  // On a high-density display the capture is a whole multiple of the rectangle: render at that density and
  // scale down to the exact size (a clean 2:1 reduction at 2x), instead of fighting the display scale.
  if (size.width !== w || size.height !== h) {
    if (size.width % w !== 0 || size.height % h !== 0) throw new Error(`captured ${size.width}x${size.height}, expected ${w}x${h}`);
    image = image.resize({ width: w, height: h, quality: "best" });
  }
  return image.toPNG();
}

async function rasterize(svgText, w, h = w) {
  const uri = "data:image/svg+xml;base64," + Buffer.from(svgText).toString("base64");
  return page(`<img src="${uri}" style="display:block;width:${w}px;height:${h}px">`, w, h);
}

function ico(entries) {
  // PNG-in-ICO (Windows Vista and later, every browser).
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.png)]);
}

const write = (rel, data) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log("  ", rel);
};

async function banner() {
  const font = fs.readFileSync(path.join(root, "public/fonts/Montserrat/Montserrat_700_normal_latin.woff2")).toString("base64");
  const mark = "data:image/svg+xml;base64," + Buffer.from(markSvg).toString("base64");
  const html = `<style>
    @font-face{font-family:M;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:700}
    .b{width:946px;height:292px;background:#0C0F13;display:flex;align-items:center;gap:34px;padding:0 64px;box-sizing:border-box}
    .b img{height:160px;flex:none}
    .b span{font:700 112px/1 M;letter-spacing:2px;color:#E5E7EB;white-space:nowrap}
  </style><div class="b"><img src="${mark}"><span>OVERLORD</span></div>`;
  // The word takes the room the mark leaves: shrink the font until it fits (never clipped, whatever the font).
  const fit = `
    const word = document.querySelector(".b span");
    const room = 946 - 64 * 2 - document.querySelector(".b img").getBoundingClientRect().width - 34;
    for (let size = 112; size > 40 && word.getBoundingClientRect().width > room; size--) word.style.fontSize = size + "px";`;
  return page(html, 946, 292, fit);
}

async function main() {
  console.log("sources");
  write("docs/logo/overlord-icon.svg", svg("icon", MASTER));
  write("docs/logo/overlord-icon-flat.svg", svg("flat", MASTER));
  write("docs/logo/overlord-icon-flat-small.svg", svg("flat", SMALL));
  write("docs/logo/overlord-icon-square.svg", svg("square", MASTER));
  write("docs/logo/overlord-mark.svg", markSvg);

  console.log("favicons");
  for (const s of [16, 32, 96, 128, 196]) {
    write(`public/favicons/favicon-${s === 128 ? "128" : `${s}x${s}`}.png`, await rasterize(flatFor(s), s));
  }
  for (const s of [57, 60, 72, 76, 114, 120, 144, 152]) {
    write(`public/favicons/apple-touch-icon-${s}x${s}.png`, await rasterize(svg("square", MASTER), s));
  }
  write(
    "public/favicons/favicon.ico",
    ico(await Promise.all([16, 24, 32, 48, 64].map(async (size) => ({ size, png: await rasterize(flatFor(size), size) }))))
  );
  for (const [name, w, h] of [["mstile-70x70", 128, 128], ["mstile-144x144", 144, 144], ["mstile-150x150", 270, 270], ["mstile-310x310", 558, 558]]) {
    write(`public/favicons/${name}.png`, await rasterize(svg("square", MASTER), w, h));
  }
  // Wide tile: the mark centred on a transparent tile.
  {
    const mark = "data:image/svg+xml;base64," + Buffer.from(markSvg).toString("base64");
    const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 558 270"><rect width="558" height="270" fill="#0C0F13"/><image href="${mark}" x="${(558 - 255) / 2}" y="${(270 - 225) / 2}" width="255" height="225"/></svg>`;
    write("public/favicons/mstile-310x150.png", await rasterize(tile, 558, 270));
  }

  console.log("desktop app");
  for (const s of [16, 32, 48]) write(`electron/assets/icon-${s}.png`, await rasterize(flatFor(s), s));
  for (const s of [64, 128, 256, 512]) write(`electron/assets/icon-${s}.png`, await rasterize(svg("icon", MASTER), s));
  write(
    "electron/assets/icon.ico",
    ico(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async (size) => ({ size, png: await rasterize(flatFor(size), size) }))))
  );
  if (process.platform === "darwin") {
    const set = path.join(os.tmpdir(), "overlord.iconset");
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    const entries = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];
    for (const [base, scale] of entries) {
      const px = base * scale;
      const drawing = px <= 32 ? flatFor(px) : svg("icon", MASTER);
      fs.writeFileSync(path.join(set, `icon_${base}x${base}${scale === 2 ? "@2x" : ""}.png`), await rasterize(drawing, px));
    }
    const icns = path.join(root, "electron/assets/icon.icns");
    execFileSync("iconutil", ["-c", "icns", set, "-o", icns]);
    console.log("   electron/assets/icon.icns");
  }

  console.log("docs");
  write("docs/overlord-logo-squared.png", await rasterize(svg("square", MASTER), 1000));
  write("docs/overlord-logo-squared-rounded.png", await rasterize(svg("flat", MASTER), 1000));
  write("docs/overlord-banner.png", await banner());
}

app.whenReady().then(() => main().then(() => app.quit(), (e) => { console.error(e); app.exit(1); }));
