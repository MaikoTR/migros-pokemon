// Throwaway probe of the Migros API, run once on GitHub Actions. Results are printed as notices.
import https from "node:https";
import zlib from "node:zlib";

const agent = new https.Agent({ minVersion: "TLSv1.3", keepAlive: true, maxSockets: 4 });
const enc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const notice = (title, lines) => console.log(`::notice title=${title.replace(/[:,]/g, " ")}::${enc(lines.join("\n").slice(0, 6000))}`);

function req(method, path, { params, body, token } = {}) {
  const url = new URL(path, "https://www.migros.ch");
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = {
    Accept: "application/json, text/plain, */*", "Accept-Encoding": "gzip, br", "Accept-Language": "de", "Migros-Language": "de",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0", Origin: "https://www.migros.ch", Referer: "https://www.migros.ch/",
  };
  if (token) headers.leshopch = token;
  if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = payload.length; }
  const t0 = Date.now();
  return new Promise((resolve) => {
    const r = https.request(url, { method, headers, agent, timeout: 30000 }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let raw = Buffer.concat(chunks);
        try { if (res.headers["content-encoding"] === "br") raw = zlib.brotliDecompressSync(raw); else if (res.headers["content-encoding"] === "gzip") raw = zlib.gunzipSync(raw); } catch {}
        let data = raw.toString(); try { data = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, data, ms: Date.now() - t0, urlLen: url.toString().length });
      });
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", (e) => resolve({ status: 0, data: String(e.message), ms: Date.now() - t0, urlLen: url.toString().length }));
    if (payload) r.write(payload); r.end();
  });
}

const tok = (await req("GET", "/authentication/public/v1/api/guest", { params: { authorizationNotRequired: "true" } })).headers.leshopch;
const fmt = (s) => `${s.costCenterId}|${s.storeName}|${s.location?.zip} ${s.location?.city}|${s.storeType}`;

// 1. How store search behaves for different queries
const lines1 = [];
for (const q of ["", "4800", "4803", "Zofingen", "Zürich", "8001", "Genève", "Aargau", "Migros", "a"]) {
  const r = await req("GET", "/store/public/v1/stores/search", { params: { query: q }, token: tok });
  const arr = Array.isArray(r.data) ? r.data : [];
  lines1.push(`q="${q}" status=${r.status} n=${arr.length} ${r.ms}ms :: ${arr.slice(0, 3).map(fmt).join(" ; ")}${Array.isArray(r.data) ? "" : " :: " + JSON.stringify(r.data).slice(0, 150)}`);
}
const one = (await req("GET", "/store/public/v1/stores/search", { params: { query: "4800" }, token: tok })).data;
lines1.push("KEYS: " + Object.keys(one?.[0] || {}).join(","));
lines1.push("SAMPLE: " + JSON.stringify({ ...(one?.[0] || {}), openingHours: undefined }).slice(0, 700));
for (const p of ["/store/public/v1/stores", "/store/public/v1/stores?limit=2000", "/store/public/v1/stores/all"]) {
  const r = await req("GET", p, { token: tok });
  lines1.push(`${p} -> ${r.status} ${Array.isArray(r.data) ? "array n=" + r.data.length : JSON.stringify(r.data).slice(0, 160)}`);
}
notice("1 store search", lines1);

// 2. Enumerate stores with a grid of postcodes
const all = new Map(); const counts = []; const types = {};
const t0 = Date.now();
for (let z = 1000; z <= 9600; z += 100) {
  const r = await req("GET", "/store/public/v1/stores/search", { params: { query: String(z) }, token: tok });
  const arr = Array.isArray(r.data) ? r.data : [];
  let fresh = 0;
  for (const s of arr) { if (!all.has(s.costCenterId)) { all.set(s.costCenterId, s); fresh++; } }
  counts.push(`${z}:${r.status === 200 ? arr.length : "E" + r.status}/+${fresh}`);
}
for (const s of all.values()) types[s.storeType] = (types[s.storeType] || 0) + 1;
const withCoords = [...all.values()].filter((s) => s.location?.latitude).length;
notice("2 grid enumeration", [
  `unique stores: ${all.size} (with coords ${withCoords}) in ${Date.now() - t0}ms over 87 queries`,
  `types: ${JSON.stringify(types)}`,
  counts.join(" "),
  "zips covered sample: " + [...new Set([...all.values()].map((s) => s.location?.zip))].sort().slice(0, 60).join(","),
]);

// 3. Stock call batch sizes
const search = (await req("POST", "/onesearch-oc-seaapi/public/v5/search", { token: tok, body: { regionId: "national", language: "de", productIds: [], query: "pokemon", sortFields: [], sortOrder: "asc", algorithm: "DEFAULT", from: 0, limit: 100 } })).data;
const pid = search?.productIds?.[0];
const ids = [...all.keys()];
const lines3 = [`product ${pid}, search n=${search?.numberOfProducts}`];
for (const n of [10, 50, 100, 200, 400, ids.length]) {
  if (n > ids.length && n !== ids.length) continue;
  const r = await req("GET", `/store-availability/public/v2/availabilities/products/${pid}`, { params: { costCenterIds: ids.slice(0, n).join(",") }, token: tok });
  const av = r.data?.availabilities || [];
  lines3.push(`n=${n} status=${r.status} urlLen=${r.urlLen} returned=${av.length} withStock=${av.filter((a) => a.stock > 0).length} ${r.ms}ms ${r.status !== 200 ? JSON.stringify(r.data).slice(0, 120) : ""}`);
}
notice("3 stock batches", lines3);

// 4. Products per region (brand filter)
const brandSlug = (search?.features || []).find((f) => f.id === "brand")?.values?.filter((v) => /pok/i.test(v.value)).map((v) => v.slug) || [];
const lines4 = [`brand slugs: ${brandSlug.join(",")}`];
const union = new Set();
for (const region of ["national", "gmaa", "gmbs", "gmge", "gmlu", "gmnf", "gmos", "gmti", "gmvd", "gmvs", "gmzh"]) {
  const r = await req("POST", "/onesearch-oc-seaapi/public/v5/search", { token: tok, body: { regionId: region, language: "de", productIds: [], query: "", sortFields: [], sortOrder: "asc", algorithm: "DEFAULT", from: 0, limit: 100, filters: { brand: brandSlug } } });
  const p = r.data?.productIds || [];
  p.forEach((x) => union.add(x));
  lines4.push(`${region}: status=${r.status} n=${p.length} total=${r.data?.numberOfProducts}`);
}
lines4.push(`union=${union.size}`);
notice("4 regions", lines4);
agent.destroy();
