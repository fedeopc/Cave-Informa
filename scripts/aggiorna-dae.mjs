// Cave Informa · aggiorna l'elenco dei defibrillatori (DAE) leggendo la mappa pubblica della Croce Rossa.
// Lo esegue GitHub Actions ogni ora (.github/workflows/dae.yml). Scrive dae.json solo se l'elenco è cambiato.
import { readFile, writeFile } from "node:fs/promises";

const MAP_ID = "1i_VWr2qEZsH_mhhseaKbxg-eUrc3HS8X";
const KML_URL = `https://www.google.com/maps/d/kml?mid=${MAP_ID}&forcekml=1`;
const MAP_URL = `https://www.google.com/maps/d/viewer?mid=${MAP_ID}`;
const OUT = "dae.json";
const CAVE = { lat: 41.8189, lon: 12.9306 };
const MAX_KM = 15;          // punti più lontani da Cave vengono ignorati (errori di posizione)
const MIN_RATIO = 0.5;      // se i DAE calano di oltre la metà in un colpo solo, non sovrascrivo: probabile errore

const km = (a, b) => { const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
const text = (s) => decode(String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
  .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? m[1] : ""; };

function parse(kml) {
  const out = [];
  for (const m of kml.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/gi)) {
    const pm = m[0];
    const point = tag(pm, "Point"); if (!point) continue;             // solo punti, non linee o aree
    const [lon, lat] = tag(point, "coordinates").trim().split(/[\s,]+/).map(Number);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const nome = text(tag(pm, "name")).slice(0, 120) || "Defibrillatore";
    const descrizione = text(tag(pm, "description")).slice(0, 300);
    if (km(CAVE, { lat, lon }) > MAX_KM) { console.log(`Ignorato (lontano da Cave): ${nome}`); continue; }
    out.push({ nome, lat: +lat.toFixed(7), lon: +lon.toFixed(7), ...(descrizione ? { descrizione } : {}) });
  }
  return out;
}

const res = await fetch(KML_URL, { headers: { "User-Agent": "CaveInforma-DAE/1.0 (GitHub Actions)" } });
if (!res.ok) { console.error(`Mappa non raggiungibile: HTTP ${res.status}. Resta l'elenco attuale.`); process.exit(1); }
const kml = await res.text();
if (!/<kml\b/i.test(kml)) { console.error("La risposta non è una mappa KML (forse la mappa non è più pubblica). Resta l'elenco attuale."); process.exit(1); }
const dae = parse(kml);
console.log(`Trovati ${dae.length} DAE sulla mappa.`);

let prev = null;
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const prevN = prev?.dae?.length || 0;
if (!dae.length) { console.error("Nessun DAE trovato: non sovrascrivo. Resta l'elenco attuale."); process.exit(1); }
if (prevN && dae.length < prevN * MIN_RATIO) { console.error(`DAE scesi da ${prevN} a ${dae.length}: non sovrascrivo per sicurezza. Controllare la mappa.`); process.exit(1); }

if (prev && JSON.stringify(prev.dae) === JSON.stringify(dae)) { console.log("Nessuna modifica."); process.exit(0); }
const data = { fonte: "Mappa pubblica dei defibrillatori di Cave curata dalla Croce Rossa Italiana", mappa: MAP_URL, aggiornato: new Date().toISOString(), dae };
await writeFile(OUT, JSON.stringify(data, null, 2) + "\n");
console.log(`dae.json aggiornato (${prevN} → ${dae.length} DAE).`);
