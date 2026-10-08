#!/usr/bin/env node
/*
 * Migros Pokémon stock checker
 * ----------------------------------------------------------------------------
 * Lists every Pokémon product Migros sells and how many are in stock at the
 * Migros stores serving a list of postal codes (postcodes.json: every postal
 * code within 10 km of Zofingen), using the same public API migros.ch uses.
 * Visitors pick which postal codes they want to see on the page.
 * No dependencies, needs Node.js 18 or newer.
 *
 *   node migros-pokemon.mjs                 start the page at http://localhost:4800
 *   node migros-pokemon.mjs --list          print the stock list in the terminal
 *   node migros-pokemon.mjs --site public   write a static website (index.html + data.json)
 *   node migros-pokemon.mjs --out page.html save a one-off snapshot page
 *
 * Options
 *   --postcodes <file> postal codes to cover            (default: postcodes.json next to this script)
 *   --place <name>     area name in the page title      (default: Zofingen)
 *   --max-km <n>       ignore postal codes whose nearest Migros is further away (default: 10)
 *   --query <text>     product search                   (default: pokemon)
 *   --port <n>         port for the page                (default: 4800)
 *   --local            only reachable from this computer (default: also your Wi-Fi)
 *   --note <text>      extra line in the page footer (e.g. how often it updates)
 *
 * postcodes.json is a list of {"plz", "name", "km", "lat", "lng"} (lat/lng optional).
 * Each postal code maps to the Migros stores located in it, or to the nearest
 * Migros when it has none.
 *
 * Not affiliated with Migros. Their API is unofficial and can change.
 */

import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import os from "node:os";
import fs from "node:fs";

// ─── Config ─────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("*/")[0].replace(/^#!.*\n\/\*/, "").replace(/^ \* ?/gm, ""));
  process.exit(0);
}

const CONFIG = {
  place: String(args.place ?? "Zofingen"),
  postcodesFile: args.postcodes ? String(args.postcodes) : new URL("postcodes.json", import.meta.url),
  maxKm: Number(args["max-km"] ?? 10),
  query: String(args.query ?? "pokemon"),
  port: Number(args.port ?? 4800),
  host: args.local ? "127.0.0.1" : "0.0.0.0",
  language: "de",
  cacheMinutes: 10,
};

// Only for testing against a local mock; leave unset for the real site.
const BASE_URL = process.env.MIGROS_BASE || "https://www.migros.ch";
const MATCH = /pok[eé]mon/i;
const STOCK_BATCH = 10; // Migros accepts at most 10 stores per stock lookup

// ─── HTTP client ────────────────────────────────────────────────────────────
// migros.ch sits behind Cloudflare, which rejects clients that don't look like
// a browser. A TLS 1.3 connection plus browser headers is what gets through.

const tlsAgent = new https.Agent({ minVersion: "TLSv1.3", keepAlive: true, maxSockets: 6 });

function request(method, path, { params, body, token } = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": CONFIG.language,
    "Migros-Language": CONFIG.language,
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
    Origin: "https://www.migros.ch",
    Referer: "https://www.migros.ch/",
  };
  if (token) headers.leshopch = token;
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = payload.length;
  }
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers, agent: isHttps ? tlsAgent : undefined, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let raw = Buffer.concat(chunks);
        try {
          const enc = res.headers["content-encoding"];
          if (enc === "br") raw = zlib.brotliDecompressSync(raw);
          else if (enc === "gzip") raw = zlib.gunzipSync(raw);
          else if (enc === "deflate") raw = zlib.inflateSync(raw);
        } catch (e) {
          return reject(new Error(`Couldn't decompress response from ${url.pathname}: ${e.message}`));
        }
        const text = raw.toString("utf8");
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        if (res.statusCode >= 400) {
          const err = new Error(`Migros answered ${res.statusCode} for ${url.pathname}`);
          err.status = res.statusCode;
          err.body = text.slice(0, 300);
          return reject(err);
        }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out waiting for ${url.pathname}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// One retry for server hiccups and dropped connections.
async function again(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status && err.status < 500) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    return fn();
  }
}

// ─── Guest token ────────────────────────────────────────────────────────────

let token = null;
let tokenAt = 0;

async function freshToken() {
  const res = await request("GET", "/authentication/public/v1/api/guest", { params: { authorizationNotRequired: "true" } });
  const t = res.headers.leshopch || res.data?.token || res.data?.leshopch;
  if (!t) throw new Error("Migros didn't hand out a guest token (no 'leshopch' header).");
  token = t;
  tokenAt = Date.now();
  return t;
}

async function withToken(fn) {
  if (!token || Date.now() - tokenAt > 6 * 3600e3) await freshToken();
  try {
    return await fn(token);
  } catch (err) {
    if (err.status === 401 || err.status === 403) return fn(await freshToken());
    throw err;
  }
}

// ─── Migros API calls ───────────────────────────────────────────────────────

const api = {
  // The 10 Migros stores nearest to a postal code or town.
  stores: (query) =>
    withToken((t) => request("GET", "/store/public/v1/stores/search", { params: { query }, token: t })).then((r) => r.data),

  cooperative: (zipCode) =>
    withToken((t) => request("GET", "/fulfilment-selector/public/v1/fulfilment-selection", { params: { zipCode }, token: t })).then(
      (r) => r.data?.cooperative
    ),

  search: (query, region, filters, from = 0) =>
    withToken((t) =>
      request("POST", "/onesearch-oc-seaapi/public/v5/search", {
        token: t,
        body: {
          regionId: region,
          language: CONFIG.language,
          productIds: [],
          query,
          sortFields: [],
          sortOrder: "asc",
          algorithm: "DEFAULT",
          from,
          limit: 100,
          ...(filters ? { filters } : {}),
        },
      })
    ).then((r) => r.data),

  productCards: (uids, region) =>
    withToken((t) =>
      request("POST", "/product-display/public/v4/product-cards", {
        token: t,
        body: {
          productFilter: { uids },
          language: CONFIG.language,
          offerFilter: { storeType: "OFFLINE", region, ongoingOfferDate: todayZurich() + "T00:00:00" },
        },
      })
    ).then((r) => r.data),

  // Stock of one product in up to 10 stores.
  stock: (uid, costCenterIds) =>
    withToken((t) =>
      request("GET", `/store-availability/public/v2/availabilities/products/${uid}`, {
        params: { costCenterIds: costCenterIds.join(",") },
        token: t,
      })
    ).then((r) => r.data),
};

// ─── Gathering the data ─────────────────────────────────────────────────────

function loadPostcodes() {
  try {
    const list = JSON.parse(fs.readFileSync(CONFIG.postcodesFile, "utf8"));
    if (Array.isArray(list) && list.length) return list.map((p) => ({ ...p, plz: String(p.plz) }));
  } catch (err) {
    if (args.postcodes) throw new Error(`Couldn't read ${args.postcodes}: ${err.message}`);
  }
  return [{ plz: "4800", name: "Zofingen", km: 0 }];
}

function toStore(s) {
  const today = todayZurich();
  const day = (s.openingHours || []).find((d) => d.date === today);
  const slot = day?.hours?.find((h) => h.open && h.close);
  const loc = s.location || {};
  return {
    id: s.costCenterId || s.storeId,
    name: s.storeName || s.name || `Store ${s.storeId}`,
    address: [loc.address, [loc.zip, loc.city].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    zip: loc.zip || "",
    type: s.storeType || null,
    hoursToday: day ? (slot ? `${slot.open.slice(11, 16)}–${slot.close.slice(11, 16)}` : "closed") : null,
    lat: loc.latitude ?? null,
    lng: loc.longitude ?? null,
  };
}

// For every postal code: the Migros stores located in it, or the nearest one.
async function findArea(notes) {
  const list = loadPostcodes();
  const stores = new Map();
  const found = new Array(list.length);
  const skipped = [];

  await pool(list.map((pc, i) => [pc, i]), 4, async ([pc, i]) => {
    const results = ((await again(() => api.stores(pc.plz))) || []).filter((s) => s.location);
    const cands = results.map((s, order) => ({
      s,
      order,
      d: pc.lat != null && s.location.latitude != null ? distanceKm(pc.lat, pc.lng, s.location.latitude, s.location.longitude) : null,
    }));
    let chosen = cands.filter((c) => c.s.location.zip === pc.plz);
    const nearest = chosen.length === 0;
    if (nearest) chosen = cands.sort((a, b) => (a.d ?? a.order) - (b.d ?? b.order)).slice(0, 1);
    // No store, or only far-away ones: Migros doesn't recognise this code (PO box or company codes).
    if (!chosen.length || (nearest && chosen[0].d != null && chosen[0].d > CONFIG.maxKm)) {
      skipped.push(pc.plz);
      return;
    }
    for (const c of chosen) {
      const st = toStore(c.s);
      if (!stores.has(st.id)) stores.set(st.id, st);
    }
    found[i] = {
      plz: pc.plz,
      name: pc.name || pc.plz,
      km: pc.km ?? null,
      stores: chosen.map((c) => c.s.costCenterId || c.s.storeId),
      nearest,
      nearestKm: nearest && chosen[0].d != null ? Math.round(chosen[0].d * 10) / 10 : null,
    };
  });

  const postcodes = found.filter(Boolean);
  if (!postcodes.length) throw new Error("Migros didn't return a store for any of the postal codes.");
  if (skipped.length) console.log(`Skipped postal codes Migros doesn't serve: ${skipped.join(", ")}`);

  // Stores in the order of the postal codes that use them (closest to the centre first).
  const order = [...new Set(postcodes.flatMap((p) => p.stores))];
  return { postcodes, stores: order.map((id) => stores.get(id)) };
}

async function searchAllIds(query, region, filters) {
  const ids = [];
  let features = [];
  for (let page = 0; page < 10; page++) {
    const r = await again(() => api.search(query, region, filters, ids.length));
    if (page === 0) features = r?.features || [];
    const batch = r?.productIds || [];
    ids.push(...batch);
    if (batch.length === 0 || ids.length >= (r?.numberOfProducts ?? 0)) break;
  }
  return { ids, features };
}

async function findProducts(region, notes) {
  const queries = [...new Set([CONFIG.query, CONFIG.query.replace(/pokemon/i, "pokémon")])];
  const textIds = new Set();
  const brandIds = new Set();
  const brandSlugs = new Set();

  for (const q of queries) {
    const { ids, features } = await searchAllIds(q, region);
    ids.forEach((id) => textIds.add(id));
    const brandFeature = features.find((f) => f.id === "brand" || f.slug === "brand");
    for (const v of brandFeature?.values || []) if (MATCH.test(v.value)) brandSlugs.add(v.slug);
  }

  // Everything filed under the Pokémon brand (what migros.ch/de/brand/pokemon shows).
  if (brandSlugs.size) {
    try {
      const { ids } = await searchAllIds(CONFIG.query, region, { brand: [...brandSlugs] });
      ids.forEach((id) => brandIds.add(id));
    } catch {
      /* filter not accepted; the text search still covers it */
    }
  }

  const allIds = [...new Set([...brandIds, ...textIds])];
  const cards = [];
  for (let i = 0; i < allIds.length; i += 30) {
    cards.push(...((await again(() => api.productCards(allIds.slice(i, i + 30), region))) || []));
  }
  const products = cards.filter((c) => brandIds.has(c.uid) || MATCH.test(`${c.brand || ""} ${c.name || ""} ${c.title || ""}`));
  if (!products.length) notes.push(`Migros returned no products for "${CONFIG.query}".`);
  return products;
}

async function fetchStock(products, stores) {
  const ids = stores.map((s) => s.id);
  const chunks = [];
  for (let i = 0; i < ids.length; i += STOCK_BATCH) chunks.push(ids.slice(i, i + STOCK_BATCH));
  for (const p of products) p.stock = {};
  const jobs = products.flatMap((p) => chunks.map((chunk) => [p, chunk]));
  await pool(jobs, 4, async ([p, chunk]) => {
    try {
      const r = await again(() => api.stock(p.uid, chunk));
      const byId = Object.fromEntries((r?.availabilities || []).map((a) => [a.id, Number(a.stock)]));
      for (const id of chunk) p.stock[id] = Number.isFinite(byId[id]) ? byId[id] : 0;
    } catch {
      for (const id of chunk) p.stock[id] = null;
    }
  });
}

async function gather() {
  const started = Date.now();
  const notes = [];
  const { postcodes, stores } = await findArea(notes);
  let region = "national";
  try {
    region = (await api.cooperative(postcodes[0].plz)) || "national";
  } catch {
    /* national prices are fine as a fallback */
  }
  const cards = await findProducts(region, notes);
  const products = cards.map(toProduct);
  await fetchStock(products, stores);
  for (const p of products) {
    const known = Object.values(p.stock).filter((n) => n !== null);
    p.total = known.length ? known.reduce((a, b) => a + b, 0) : null;
  }
  products.sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.name.localeCompare(b.name, "de"));
  return {
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    place: CONFIG.place,
    radiusKm: CONFIG.maxKm,
    region,
    defaultPostcodes: [postcodes[0].plz],
    postcodes,
    stores,
    products,
    notes,
  };
}

function toProduct(c) {
  const offer = c.offer || {};
  const regular = offer.price?.effectiveValue ?? offer.price?.value ?? null;
  const promo = offer.promotionPrice?.effectiveValue ?? null;
  const img = c.imageTransparent?.url || c.images?.[0]?.url || null;
  return {
    uid: c.uid,
    migrosId: c.migrosId,
    name: c.name || c.title || `Product ${c.uid}`,
    brand: c.brand || "",
    quantity: offer.quantity || "",
    price: promo ?? regular,
    regularPrice: promo != null ? regular : null,
    badges: (offer.badges || []).map((b) => b.description).filter(Boolean),
    image: img ? img.replace("{stack}", "mo-custom/v-w-200-h-200") : null,
    url: c.productUrls || `https://www.migros.ch/de/product/${c.migrosId}`,
    onlineOnly: c.productAvailability === "ONLINE_ONLY",
    stock: {},
    total: null,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayZurich() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = list[i + 1];
    if (val === undefined || val.startsWith("--")) out[key] = true;
    else { out[key] = val; i++; }
  }
  return out;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
}

function storeBreakdown(data, p) {
  return data.stores
    .filter((s) => p.stock[s.id] !== 0)
    .map((s) => `${s.name} ${p.stock[s.id] ?? "?"}`)
    .join(", ");
}

function printList(data) {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`\nPokémon at Migros around ${data.place}: ${data.stores.length} stores for ${data.postcodes.length} postal codes`);
  for (const p of data.products) {
    const stock = p.total === null ? "  ?" : String(p.total).padStart(3);
    const price = p.price != null ? `CHF ${p.price.toFixed(2)}`.padEnd(11) : "".padEnd(11);
    console.log(`${stock}  ${pad(p.name, 46)} ${price} ${storeBreakdown(data, p)}`);
  }
  const inStock = data.products.filter((p) => p.total > 0).length;
  console.log(`\n${inStock} of ${data.products.length} products in stock somewhere in the area.`);
  for (const n of data.notes) console.log(`Note: ${n}`);
}

// Shows the result on the GitHub Actions run page: a notice plus a table in the run summary.
function reportToGitHub(data, inStock) {
  const line = (p) => `${p.total === null ? "?" : p.total} × ${p.name}${p.price != null ? ` (CHF ${p.price.toFixed(2)})` : ""}${p.total ? ": " + storeBreakdown(data, p) : ""}`;
  const stores = data.stores.map((s) => `${s.name} [${s.id}]`).join(", ");
  const body = [`${data.postcodes.length} postal codes, ${data.stores.length} stores: ${stores}`, ...data.products.map(line), ...data.notes.map((n) => `Note: ${n}`)].join("\n");
  const enc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::notice title=${enc(`${inStock} of ${data.products.length} Pokémon products in stock`).replace(/[:,]/g, " ")}::${enc(body)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const cell = (s) => String(s).replace(/\|/g, "\\|");
    const rows = data.products.map((p) => `| ${p.total ?? "?"} | ${cell(p.name)} | ${p.price != null ? p.price.toFixed(2) : ""} | ${cell(p.total ? storeBreakdown(data, p) : "")} |`);
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [`### ${inStock} of ${data.products.length} Pokémon products in stock`, "", `Stores: ${stores}`, "", "| Stock | Product | CHF | Where |", "|---:|---|---:|---|", ...rows, ""].join("\n")
    );
  }
}

// ─── Page ───────────────────────────────────────────────────────────────────

function renderPage(snapshot, { source = null, note = null } = {}) {
  const globals = [];
  if (snapshot) globals.push(`window.__DATA__=${JSON.stringify(snapshot).replace(/</g, "\\u003c")};`);
  if (source) globals.push(`window.__SOURCE__=${JSON.stringify(source)};`);
  const embedded = globals.length ? `<script>${globals.join("")}</script>` : "";
  const place = escapeHtml(CONFIG.place);
  const noteHtml = note ? `<p>${escapeHtml(note)}</p>` : "";
  return PAGE.replace("<!--DATA-->", () => embedded)
    .replace("<!--NOTE-->", () => noteHtml)
    .replaceAll("{{PLACE}}", () => place)
    .replaceAll("{{RADIUS}}", () => String(CONFIG.maxKm));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pokémon at Migros around {{PLACE}}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#ECEEF1; --surface:#FFFFFF; --ink:#15181E; --muted:#596170; --line:#D8DCE2;
  --band:#FF6600; --action:#B83F00; --action-ink:#FFFFFF;
  --in:#0D7A42; --low:#A85700; --out:#8A909B; --promo:#C4002B;
  --focus:#1F5FD6; --hover:#E3E6EA;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#111317; --surface:#1A1D22; --ink:#ECEEF1; --muted:#9BA2AE; --line:#2B2F36;
    --band:#FF6600; --action:#FF7A1F; --action-ink:#1A0B00;
    --in:#4BC488; --low:#F2A43B; --out:#6C727D; --promo:#FF6B86;
    --focus:#7FA8FF; --hover:#252930;
    color-scheme:dark;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 Barlow,system-ui,-apple-system,"Segoe UI",sans-serif}
.band{height:6px;background:var(--band)}
.wrap{max-width:760px;margin:0 auto;padding:0 16px}
header{padding:20px 0 8px}
h1{font:600 clamp(30px,8vw,44px)/1 "Barlow Condensed",Barlow,sans-serif;margin:0;letter-spacing:-.01em}
button,select,input{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}

.area{margin-top:16px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.chip{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:4px 6px 4px 12px;border:1px solid var(--line);border-radius:999px;background:var(--surface);cursor:pointer;font-size:15px}
.chip b{font-weight:600;font-variant-numeric:tabular-nums}
.chip .x{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;color:var(--muted);font-size:18px;line-height:1}
.chip:hover .x{background:var(--hover);color:var(--ink)}
.more{border:0;background:none;color:var(--action);font-weight:600;cursor:pointer;min-height:36px;padding:0 6px}
.add{position:relative;margin-top:10px}
.add input{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.suggest{position:absolute;z-index:5;left:0;right:0;top:calc(100% + 4px);margin:0;padding:4px;list-style:none;background:var(--surface);border:1px solid var(--line);border-radius:8px;max-height:min(320px,55vh);overflow:auto;box-shadow:0 10px 30px rgba(10,14,20,.18)}
.suggest[hidden]{display:none}
.suggest button{display:block;width:100%;text-align:left;border:0;background:none;padding:8px 10px;border-radius:6px;cursor:pointer;min-height:44px}
.suggest button:hover,.suggest button.active{background:var(--hover)}
.suggest b{font-variant-numeric:tabular-nums}
.suggest small{display:block;color:var(--muted);font-size:13px}
.suggest .none{padding:10px;color:var(--muted);font-size:15px}
.tools{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:14px;color:var(--muted)}
.tools button{border:0;background:none;padding:0;color:var(--action);font-weight:600;cursor:pointer;min-height:32px}
.stores{margin:10px 0 0;padding:0;list-style:none;color:var(--muted);font-size:15px}
.stores li+li{margin-top:4px}
.stores b{color:var(--ink);font-weight:600}
details.stores-wrap{margin-top:10px;font-size:15px;color:var(--muted)}
details.stores-wrap summary{cursor:pointer;color:var(--ink);padding:6px 0}
details.stores-wrap summary b{font-weight:600}
details.stores-wrap .stores{margin-top:4px}

.status{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.summary{margin:0;font-size:15px}
.summary strong{font:600 20px/1 "Barlow Condensed",sans-serif}
.updated{display:block;color:var(--muted);font-size:13px}
.refresh{flex:none;border:0;border-radius:8px;background:var(--action);color:var(--action-ink);font-weight:600;padding:10px 16px;min-height:44px;cursor:pointer}
.refresh[disabled]{opacity:.6;cursor:progress}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 6px}
.controls[hidden]{display:none}
.search{flex:1 1 100%;min-width:0;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.seg{flex:none;display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--surface)}
.seg button{border:0;background:transparent;padding:8px 14px;min-height:42px;cursor:pointer;color:var(--muted)}
.seg button[aria-pressed=true]{background:var(--ink);color:var(--surface);font-weight:600}
#sort{flex:1 1 140px}
select{min-height:44px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);max-width:100%}

.list{list-style:none;margin:8px 0 0;padding:0}
.item{display:grid;grid-template-columns:64px 1fr auto;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid var(--line)}
.thumb{width:64px;height:64px;border-radius:6px;background:var(--surface);object-fit:contain;display:block}
.thumb.none{border:1px dashed var(--line)}
.name{font-weight:500;line-height:1.3;color:var(--ink);text-decoration:none;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.name:hover{text-decoration:underline}
.meta{margin-top:4px;font-size:14px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
.price{font-weight:600;color:var(--ink)}
.price.promo{color:var(--promo)}
.was{text-decoration:line-through}
.badge{font-size:12px;font-weight:600;color:var(--promo)}
.where{margin:6px 0 0;font-size:13px;color:var(--muted)}
.where .w{white-space:nowrap}
.where b{font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600}
.count{text-align:right;min-width:64px}
.count .n{display:block;font:700 44px/0.9 "Barlow Condensed",sans-serif;font-variant-numeric:tabular-nums}
.count .l{display:block;font-size:12px;margin-top:4px;color:var(--muted)}
.in .n{color:var(--in)} .low .n{color:var(--low)} .out .n,.unknown .n{color:var(--out)}
.out .name,.out .thumb{opacity:.6}
.empty,.error{margin:28px 0;padding:20px;border-radius:10px;background:var(--surface)}
.empty p,.error p{margin:0 0 12px}
.error{border:1px solid var(--promo)}
.linkish{border:0;background:none;color:var(--action);font-weight:600;padding:0;cursor:pointer;text-decoration:underline}
footer{color:var(--muted);font-size:13px;padding:24px 0 40px}
footer p{margin:0 0 6px}
.loading{padding:40px 0;color:var(--muted)}
@media (min-width:640px){
  .search{flex:1 1 200px}
  #sort{flex:0 1 auto}
  .item{grid-template-columns:80px 1fr auto}
  .thumb{width:80px;height:80px}
}
@media (prefers-reduced-motion:no-preference){
  .refresh[disabled]::after{content:"";display:inline-block;width:10px;height:10px;margin-left:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-1px}
  @keyframes spin{to{transform:rotate(1turn)}}
}
</style>
</head>
<body>
<div class="band"></div>
<div class="wrap">
  <header>
    <h1>Pokémon at Migros around {{PLACE}}</h1>
    <section class="area" id="area" aria-label="Postal codes" hidden>
      <ul class="chips" id="chips"></ul>
      <div class="add">
        <input id="plz" type="text" inputmode="search" enterkeyhint="done" autocomplete="off" spellcheck="false"
          placeholder="Add a postal code or town" aria-label="Add a postal code or town"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="suggest">
        <ul class="suggest" id="suggest" role="listbox" hidden></ul>
      </div>
      <div class="tools" id="tools"></div>
      <div id="storeinfo"></div>
    </section>
    <div class="status">
      <p class="summary" id="summary">Checking stock…</p>
      <button class="refresh" id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <div class="controls" id="controls" hidden>
    <input class="search" id="q" type="search" placeholder="Search products" aria-label="Search products" autocomplete="off">
    <div class="seg" role="group" aria-label="Which products">
      <button type="button" id="f-in" aria-pressed="true">In stock</button>
      <button type="button" id="f-all" aria-pressed="false">All</button>
    </div>
    <select id="sort" aria-label="Sort by">
      <option value="stock">Most in stock</option>
      <option value="price">Lowest price</option>
      <option value="name">Name</option>
    </select>
  </div>
  <main id="main"><p class="loading">Asking Migros what's on the shelf…</p></main>
  <footer>
    <!--NOTE-->
    <p>Covers every postal code within {{RADIUS}} km of {{PLACE}}. A postal code without its own Migros shows the nearest one.</p>
    <p>Stock counts come from Migros' own availability data and can lag behind the shelf by a few hours.</p>
    <p>Not affiliated with Migros. Postal code locations from GeoNames (CC BY 4.0).</p>
  </footer>
</div>
<!--DATA-->
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const snapshot = window.__DATA__ || null;   // data baked into the page
  const source = window.__SOURCE__ || null;   // static site: data.json next to the page
  const STORAGE_KEY = "pokemon-migros-plz";
  const CHIP_LIMIT = 8;
  let lastLoad = Date.now();
  const state = { data: null, selected: [], q: "", onlyInStock: true, sort: "stock", chipsOpen: false, active: -1 };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const chf = (n) => n == null ? "" : "CHF " + n.toFixed(2);
  const time = (iso) => {
    const d = new Date(iso);
    const hm = d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString("de-CH", { day: "numeric", month: "numeric" }) + " " + hm;
  };

  if (snapshot && !source) $("refresh").hidden = true;

  // ── Postal code selection ────────────────────────────────────────────────
  const byPlz = () => new Map(state.data.postcodes.map((p) => [p.plz, p]));
  const storeById = () => new Map(state.data.stores.map((s) => [s.id, s]));

  function initialSelection() {
    const valid = byPlz();
    const clean = (list) => list.map((x) => String(x).trim()).filter((x, i, a) => valid.has(x) && a.indexOf(x) === i);
    const fromUrl = clean((new URLSearchParams(location.search).get("plz") || "").split(","));
    if (fromUrl.length) return fromUrl;
    try {
      const saved = clean(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
      if (saved.length) return saved;
    } catch (e) { /* storage unavailable */ }
    return clean(state.data.defaultPostcodes || []).length ? clean(state.data.defaultPostcodes) : [state.data.postcodes[0].plz];
  }

  function saveSelection() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.selected)); } catch (e) { /* storage unavailable */ }
    try {
      const params = new URLSearchParams(location.search);
      params.delete("plz");
      const rest = params.toString();
      const query = [state.selected.length ? "plz=" + state.selected.join(",") : "", rest].filter(Boolean).join("&");
      history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
    } catch (e) { /* file:// or sandboxed */ }
  }

  function setSelection(list) {
    state.selected = list;
    saveSelection();
    renderArea();
    render();
  }

  function addPlz(plz) {
    if (!state.selected.includes(plz)) setSelection(state.selected.concat(plz));
    $("plz").value = "";
    state.active = -1;
    renderSuggest();
  }

  function removePlz(plz) { setSelection(state.selected.filter((p) => p !== plz)); }

  function selectedStores() {
    const pcs = byPlz();
    const stores = storeById();
    const ids = [...new Set(state.selected.flatMap((plz) => (pcs.get(plz) ? pcs.get(plz).stores : [])))];
    return ids.map((id) => stores.get(id)).filter(Boolean);
  }

  function serves(pc) {
    const stores = storeById();
    const names = pc.stores.map((id) => (stores.get(id) || {}).name).filter(Boolean);
    if (pc.nearest) return "Nearest Migros: " + names[0] + (pc.nearestKm != null ? ", " + pc.nearestKm.toFixed(1) + " km" : "");
    return "Migros " + names.join(", ");
  }

  function renderArea() {
    const d = state.data;
    $("area").hidden = false;
    const pcs = byPlz();
    const sel = state.selected.map((plz) => pcs.get(plz)).filter(Boolean);
    const shown = state.chipsOpen || sel.length <= CHIP_LIMIT ? sel : sel.slice(0, CHIP_LIMIT - 2);
    $("chips").innerHTML = shown.map((pc) =>
      '<li><button type="button" class="chip" data-remove="' + esc(pc.plz) + '" aria-label="Remove ' + esc(pc.plz + " " + pc.name) + '">' +
      "<span><b>" + esc(pc.plz) + "</b> " + esc(pc.name) + '</span><span class="x" aria-hidden="true">×</span></button></li>'
    ).join("") + (shown.length < sel.length ? '<li><button type="button" class="more" data-chips="open">and ' + (sel.length - shown.length) + " more</button></li>" : "")
      + (state.chipsOpen && sel.length > CHIP_LIMIT ? '<li><button type="button" class="more" data-chips="close">Show fewer</button></li>' : "");

    const left = d.postcodes.length - sel.length;
    $("tools").innerHTML =
      (left > 0 ? '<button type="button" data-all>Add all ' + d.postcodes.length + " postal codes</button>" : "<span>All " + d.postcodes.length + " postal codes within " + esc(d.radiusKm) + " km added</span>") +
      (sel.length > 1 ? '<button type="button" data-clear>Remove all</button>' : "");

    const stores = selectedStores();
    const nearestFor = {};
    for (const pc of sel) if (pc.nearest) (nearestFor[pc.stores[0]] = nearestFor[pc.stores[0]] || []).push(pc.name);
    const items = stores.map((s) =>
      "<li><b>" + esc(s.name) + "</b>" + (s.address ? ", " + esc(s.address) : "") +
      (s.hoursToday ? (s.hoursToday === "closed" ? ". Closed today." : ". Open today " + esc(s.hoursToday) + ".") : "") +
      (nearestFor[s.id] ? " Nearest Migros for " + esc(nearestFor[s.id].join(", ")) + "." : "") + "</li>"
    ).join("");
    $("storeinfo").innerHTML = !stores.length ? ""
      : stores.length <= 3 ? '<ul class="stores">' + items + "</ul>"
      : '<details class="stores-wrap"><summary><b>' + stores.length + " Migros stores</b>" +
        (stores.length <= 6 ? ": " + stores.map((s) => esc(s.name)).join(", ") : "") +
        '</summary><ul class="stores">' + items + "</ul></details>";
  }

  function matches() {
    const q = $("plz").value.trim().toLowerCase();
    const avail = state.data.postcodes.filter((pc) => !state.selected.includes(pc.plz));
    if (!q) return avail;
    return avail.filter((pc) => pc.plz.startsWith(q) || pc.name.toLowerCase().includes(q));
  }

  function renderSuggest(open) {
    const box = $("suggest");
    const input = $("plz");
    const show = open === undefined ? !box.hidden : open;
    if (!show || !state.data) { box.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
    const list = matches();
    const q = input.value.trim();
    if (!list.length) {
      box.innerHTML = '<li class="none">' + (q
        ? "No postal code within " + esc(state.data.radiusKm) + " km of " + esc(state.data.place) + " matches “" + esc(q) + "”."
        : "All postal codes are added.") + "</li>";
    } else {
      if (state.active >= list.length) state.active = list.length - 1;
      box.innerHTML = list.map((pc, i) =>
        '<li role="option" aria-selected="' + (i === state.active) + '"><button type="button" tabindex="-1" data-add="' + esc(pc.plz) + '"' + (i === state.active ? ' class="active"' : "") + ">" +
        "<b>" + esc(pc.plz) + "</b> " + esc(pc.name) + "<small>" + esc(serves(pc)) + "</small></button></li>"
      ).join("");
      const act = box.querySelector(".active");
      if (act) act.scrollIntoView({ block: "nearest" });
    }
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  // ── Product list ─────────────────────────────────────────────────────────
  function countFor(p, stores) {
    let sum = 0, known = 0;
    for (const s of stores) {
      const n = p.stock[s.id];
      if (n != null) { sum += n; known++; }
    }
    return known ? sum : null;
  }

  function level(n) {
    if (n == null) return ["unknown", "no data"];
    if (n <= 0) return ["out", "sold out"];
    if (n <= 5) return ["low", "left"];
    return ["in", "in stock"];
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const stores = selectedStores();
    const all = d.products;
    const count = (p) => countFor(p, stores);

    if (!stores.length) {
      $("summary").innerHTML = "No postal code selected" + '<span class="updated">Updated ' + esc(time(d.generatedAt)) + "</span>";
      $("controls").hidden = true;
      $("main").innerHTML = '<div class="empty"><p>Add a postal code to see what\\'s in stock nearby.</p></div>';
      return;
    }
    $("controls").hidden = false;

    const inStockCount = all.filter((p) => (count(p) ?? 0) > 0).length;
    $("summary").innerHTML = "<strong>" + inStockCount + "</strong> of " + all.length + " products in stock" +
      (stores.length > 1 ? " across " + stores.length + " stores" : " at Migros " + esc(stores[0].name)) +
      '<span class="updated">Updated ' + esc(time(d.generatedAt)) + "</span>";

    const q = state.q.trim().toLowerCase();
    let rows = all.filter((p) => !q || (p.name + " " + p.brand).toLowerCase().includes(q));
    if (state.onlyInStock) rows = rows.filter((p) => (count(p) ?? 0) > 0);
    const by = {
      stock: (a, b) => (count(b) ?? -1) - (count(a) ?? -1) || a.name.localeCompare(b.name, "de"),
      price: (a, b) => (a.price ?? 1e9) - (b.price ?? 1e9),
      name: (a, b) => a.name.localeCompare(b.name, "de"),
    }[state.sort];
    rows.sort(by);

    const notes = d.notes.map((n) => '<p class="empty">' + esc(n) + "</p>").join("");
    if (!rows.length) {
      const msg = !all.length ? "Migros doesn't list any Pokémon products right now."
        : q ? "Nothing matches “" + esc(state.q.trim()) + "”."
        : "Nothing is in stock at " + (stores.length > 1 ? "these stores" : "this store") + " right now.";
      const action = state.onlyInStock && all.length ? '<button class="linkish" type="button" data-show-all>Show sold-out products too</button>' : "";
      $("main").innerHTML = notes + '<div class="empty"><p>' + msg + "</p>" + action + "</div>";
      return;
    }

    const multi = stores.length > 1;
    $("main").innerHTML = notes + '<ul class="list">' + rows.map((p) => {
      const n = count(p);
      const [cls, label] = level(n);
      const img = p.image
        ? '<img class="thumb" src="' + esc(p.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.removeAttribute(\\'src\\');this.className=\\'thumb none\\'">'
        : '<div class="thumb none"></div>';
      const price = p.price == null ? "" : p.regularPrice != null
        ? '<span class="price promo">' + chf(p.price) + '</span><span class="was">' + chf(p.regularPrice) + "</span>"
        : '<span class="price">' + chf(p.price) + "</span>";
      const badges = p.badges.map((b) => '<span class="badge">' + esc(b) + "</span>").join("");
      const qty = p.quantity ? "<span>" + esc(p.quantity) + "</span>" : "";
      let where = "";
      if (multi && n) {
        const have = stores.filter((s) => p.stock[s.id] !== 0)
          .sort((a, b) => (p.stock[b.id] ?? -1) - (p.stock[a.id] ?? -1));
        const parts = have.slice(0, 5).map((s) => '<span class="w">' + esc(s.name) + " <b>" + (p.stock[s.id] == null ? "?" : p.stock[s.id]) + "</b></span>");
        if (have.length > 5) parts.push("and " + (have.length - 5) + " more stores");
        where = '<p class="where">' + parts.join(", ") + "</p>";
      }
      return '<li class="item ' + cls + '">' + img +
        '<div><a class="name" href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.name) + "</a>" +
        '<div class="meta">' + price + qty + badges + "</div>" + where + "</div>" +
        '<div class="count" aria-label="' + (n == null ? "Stock unknown" : n + " in stock") + '"><span class="n">' + (n == null ? "?" : n) + '</span><span class="l">' + label + "</span></div></li>";
    }).join("") + "</ul>";
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  function showError(msg) {
    $("summary").textContent = "Couldn't load the stock list.";
    const hint = source ? "Check your connection, then refresh." : "Migros sometimes blocks a burst of requests. Wait a minute, then refresh.";
    $("main").innerHTML = '<div class="error"><p>' + esc(msg) + "</p><p>" + hint + "</p></div>";
  }

  async function load(force, quiet) {
    if (!force && snapshot) { state.data = snapshot; afterLoad(); return; }
    const btn = $("refresh");
    btn.disabled = true; btn.textContent = "Refreshing";
    try {
      const url = source ? source + "?t=" + Date.now() : "/api/data" + (force ? "?refresh=1" : "");
      const res = await fetch(url, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Loading the list failed (error " + res.status + ").");
      state.data = body;
      lastLoad = Date.now();
      afterLoad();
    } catch (e) {
      const offline = e instanceof TypeError;
      const msg = offline
        ? (source ? "Couldn't reach the page." : "The tool isn't running. Start it again with: node migros-pokemon.mjs")
        : e.message;
      if (state.data) { render(); if (!quiet) alert("Refresh failed. " + msg); }
      else showError(msg);
    } finally {
      btn.disabled = false; btn.textContent = "Refresh";
    }
  }

  function afterLoad() {
    const valid = byPlz();
    state.selected = state.selected.length ? state.selected.filter((p) => valid.has(p)) : initialSelection();
    saveSelection();
    renderArea();
    render();
  }

  // ── Events ───────────────────────────────────────────────────────────────
  $("refresh").addEventListener("click", () => load(true));
  document.addEventListener("visibilitychange", () => {
    if (source && document.visibilityState === "visible" && Date.now() - lastLoad > 5 * 60e3) load(true, true);
  });

  $("area").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.remove) removePlz(t.dataset.remove);
    else if (t.dataset.add) { addPlz(t.dataset.add); $("plz").focus(); }
    else if (t.dataset.chips) { state.chipsOpen = t.dataset.chips === "open"; renderArea(); }
    else if (t.hasAttribute("data-all")) setSelection(state.data.postcodes.map((p) => p.plz));
    else if (t.hasAttribute("data-clear")) setSelection([]);
  });
  $("suggest").addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
  const input = $("plz");
  input.addEventListener("focus", () => { state.active = -1; renderSuggest(true); });
  input.addEventListener("input", () => { state.active = input.value.trim() ? 0 : -1; renderSuggest(true); });
  input.addEventListener("blur", () => setTimeout(() => renderSuggest(false), 120));
  input.addEventListener("keydown", (e) => {
    const list = matches();
    if (e.key === "ArrowDown") { e.preventDefault(); state.active = Math.min(list.length - 1, state.active + 1); renderSuggest(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); state.active = Math.max(0, state.active - 1); renderSuggest(true); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = list[state.active >= 0 ? state.active : 0];
      if (pick && input.value.trim()) addPlz(pick.plz);
    } else if (e.key === "Escape") { renderSuggest(false); input.blur(); }
  });

  $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
  const setFilter = (inOnly) => {
    state.onlyInStock = inOnly;
    $("f-in").setAttribute("aria-pressed", String(inOnly));
    $("f-all").setAttribute("aria-pressed", String(!inOnly));
    render();
  };
  $("f-in").addEventListener("click", () => setFilter(true));
  $("f-all").addEventListener("click", () => setFilter(false));
  $("main").addEventListener("click", (e) => { if (e.target.closest("[data-show-all]")) setFilter(false); });
  load(false);
})();
</script>
</body>
</html>`;

// ─── Entry points ───────────────────────────────────────────────────────────

let cache = null;
let inflight = null;

function getData(force) {
  if (!force && cache && Date.now() - cache.at < CONFIG.cacheMinutes * 60e3) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = gather()
    .then((data) => { cache = { at: Date.now(), data }; return data; })
    .finally(() => { inflight = null; });
  return inflight;
}

function describe(err) {
  if (err.status === 403) return "Migros blocked the request (403). Wait a minute and refresh; if it keeps happening, their bot protection changed.";
  if (err.status === 429) return "Migros is rate-limiting requests (429). Wait a minute, then refresh.";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(err.code)) return "Couldn't reach migros.ch. Check the internet connection.";
  return err.message;
}

async function main() {
  if (args.list || args.out || args.json || args.site) {
    try {
      const data = await gather();
      const note = typeof args.note === "string" ? args.note : null;
      if (args.json) console.log(JSON.stringify(data, null, 2));
      if (args.list) printList(data);
      if (args.out) {
        const file = args.out === true ? "pokemon-migros.html" : String(args.out);
        fs.writeFileSync(file, renderPage(data, { note }));
        console.log(`Saved ${data.products.length} products to ${file}`);
      }
      if (args.site) {
        // Never replace a working site with an empty list: if Migros returns nothing,
        // fail so the previously published page stays up.
        if (!data.products.length) throw new Error("Migros returned no Pokémon products, so the site was not updated.");
        const dir = args.site === true ? "public" : String(args.site);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${dir}/data.json`, JSON.stringify(data));
        fs.writeFileSync(`${dir}/index.html`, renderPage(data, { source: "data.json", note }));
        const inStock = data.products.filter((p) => p.total > 0).length;
        console.log(`Wrote ${dir}/index.html and ${dir}/data.json: ${data.products.length} products, ${inStock} in stock, ${data.postcodes.length} postal codes, ${data.stores.length} stores (${data.tookMs} ms)`);
        if (process.env.GITHUB_ACTIONS) reportToGitHub(data, inStock);
      }
    } catch (err) {
      console.error(describe(err));
      process.exitCode = 1;
    }
    tlsAgent.destroy();
    return;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/data") {
      try {
        const data = await getData(url.searchParams.has("refresh"));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(data));
      } catch (err) {
        console.error("Fetch failed:", err.message, err.body || "");
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: describe(err) }));
      }
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(null));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`Pokémon stock for Migros around ${CONFIG.place} is running.`);
    console.log(`  On this computer:  http://localhost:${CONFIG.port}`);
    if (CONFIG.host === "0.0.0.0") for (const ip of lanAddresses()) console.log(`  On your phone:     http://${ip}:${CONFIG.port}  (same Wi-Fi)`);
    console.log("Press Ctrl+C to stop.\n");
    getData(true).then(printList, (err) => console.error("First check failed:", describe(err)));
  });
}

main();
