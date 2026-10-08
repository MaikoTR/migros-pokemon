// Throwaway probe: postal codes within ~10 km of Zofingen (GeoNames) and the Migros stores serving them.
import https from "node:https";
import zlib from "node:zlib";
import fs from "node:fs";

const agent = new https.Agent({ minVersion: "TLSv1.3", keepAlive: true, maxSockets: 4 });
const enc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const notice = (title, lines) => console.log(`::notice title=${title.replace(/[:,]/g, " ")}::${enc(lines.join("\n").slice(0, 8000))}`);

function req(method, path, { params, token } = {}) {
  const url = new URL(path, "https://www.migros.ch");
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const headers = {
    Accept: "application/json, text/plain, */*", "Accept-Encoding": "gzip, br", "Accept-Language": "de",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0", Origin: "https://www.migros.ch", Referer: "https://www.migros.ch/",
  };
  if (token) headers.leshopch = token;
  return new Promise((resolve) => {
    const r = https.request(url, { method, headers, agent, timeout: 30000 }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let raw = Buffer.concat(chunks);
        try { if (res.headers["content-encoding"] === "br") raw = zlib.brotliDecompressSync(raw); else if (res.headers["content-encoding"] === "gzip") raw = zlib.gunzipSync(raw); } catch {}
        let data = raw.toString(); try { data = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    r.on("error", (e) => resolve({ status: 0, data: String(e.message), headers: {} }));
    r.end();
  });
}

const km = (a, b, c, d) => {
  const R = 6371, t = Math.PI / 180;
  const x = Math.sin(((c - a) * t) / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin(((d - b) * t) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

// GeoNames CH.txt: country, postal code, place, admin1 name, admin1 code, admin2 name, admin2 code, admin3 name, admin3 code, lat, lng, accuracy
const rows = fs.readFileSync("CH.txt", "utf8").trim().split("\n").map((l) => l.split("\t"));
const byPlz = new Map();
for (const r of rows) {
  const plz = r[1], lat = +r[9], lng = +r[10];
  if (!byPlz.has(plz)) byPlz.set(plz, { plz, names: [], canton: r[4], lat, lng, n: 0, latS: 0, lngS: 0, acc: r[11] });
  const e = byPlz.get(plz); e.names.push(r[2]); e.latS += lat; e.lngS += lng; e.n++;
}
for (const e of byPlz.values()) { e.lat = e.latS / e.n; e.lng = e.lngS / e.n; }
const center = byPlz.get("4800");
const near = [...byPlz.values()].map((e) => ({ ...e, km: km(center.lat, center.lng, e.lat, e.lng) })).filter((e) => e.km <= 13).sort((a, b) => a.km - b.km);
notice("1 GeoNames postcodes <=13 km", [
  `rows=${rows.length} distinct plz=${byPlz.size}; Zofingen 4800 at ${center.lat.toFixed(4)},${center.lng.toFixed(4)} (accuracy ${center.acc})`,
  ...near.map((e) => `${e.plz} ${e.names.join("/")} (${e.canton}) ${e.km.toFixed(1)} km  [${e.lat.toFixed(4)},${e.lng.toFixed(4)}]`),
]);

// Migros stores per postal code (<= 10.5 km)
const tok = (await req("GET", "/authentication/public/v1/api/guest", { params: { authorizationNotRequired: "true" } })).headers.leshopch;
const lines = []; const storeSet = new Map();
for (const e of near.filter((x) => x.km <= 10.5)) {
  const r = await req("GET", "/store/public/v1/stores/search", { params: { query: e.plz }, token: tok });
  const arr = Array.isArray(r.data) ? r.data : [];
  arr.forEach((s) => storeSet.set(s.costCenterId, s));
  const inPlz = arr.filter((s) => s.location?.zip === e.plz);
  const nearest = arr.map((s) => ({ s, d: km(e.lat, e.lng, s.location.latitude, s.location.longitude) })).sort((a, b) => a.d - b.d).slice(0, 3);
  lines.push(`${e.plz} ${e.names[0]}: status=${r.status} n=${arr.length} inPlz=[${inPlz.map((s) => `${s.costCenterId} ${s.storeName} ${s.storeType}`).join("; ")}] first=${arr[0] ? arr[0].storeName : "-"} nearest=${nearest.map((x) => `${x.s.storeName} ${x.d.toFixed(1)}km`).join(", ")}`);
}
notice("2 Migros per postcode", lines);
notice("3 stores seen", [...storeSet.values()].map((s) => `${s.costCenterId} ${s.storeName} ${s.storeType} ${s.location.zip} ${s.location.city} ${s.location.address} ${km(center.lat, center.lng, s.location.latitude, s.location.longitude).toFixed(1)}km`).sort((a, b) => parseFloat(a.split(" ").pop()) - parseFloat(b.split(" ").pop())));
agent.destroy();
