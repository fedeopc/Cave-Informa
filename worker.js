/* =====================================================================
   Cave Informa – servizio notifiche (Cloudflare Worker)

   Cosa fa:
   - tiene l'elenco dei telefoni iscritti alle notifiche (Workers KV);
   - ogni 10 minuti controlla il bollettino di criticità DPC, i terremoti INGV
     e la mappa dei defibrillatori della Croce Rossa (servita all'app su /dae);
   - invia notifiche Web Push cifrate (RFC 8291) e firmate (VAPID, RFC 8292);
   - offre i comandi per la pagina amministratori dell'app (admin.html) e, come riserva, la pagina /admin;
   - gestisce i codici personali dei volontari abilitati (creati e revocati dall'amministratore principale).

   Configurazione in Cloudflare (Settings → Variables and Secrets / Bindings):
   - KV binding          KV            (obbligatorio)
   - Secret              ADMIN_TOKEN   (obbligatorio: la password dell'amministratore principale)
   - Variable            ADMIN_NAME    (facoltativo: il nome dell'amministratore principale, es. fede)
   - Variable            CONTACT       es. mailto:protezionecivilecave1982@gmail.com
   - Secret (facoltativo) GITHUB_TOKEN token GitHub di sola lettura, evita i limiti di richieste
   - Cron trigger        ogni 10 minuti (espressione indicata nella guida)
   ===================================================================== */

const CFG = {
  comune: "Cave",
  regione: "Lazio",
  zona: "Bacino del Liri",            // zona di allerta del bollettino di criticità
  lat: 41.8189, lon: 12.9306,          // per i terremoti
  eqRadiusKm: 50, eqMinMag: 3.0,
  bcrRepo: "pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica",
  ttl: 12 * 3600,                      // validità della notifica se il telefono è spento (secondi)
  // defibrillatori: mappa pubblica della Croce Rossa Italiana - Comitato di Monti Prenestini-ODV (Google My Maps)
  daeMapId: "1i_VWr2qEZsH_mhhseaKbxg-eUrc3HS8X",
  daeMaxKm: 15,                         // punti più lontani da Cave vengono ignorati
  daeMinRatio: 0.5,                     // se i DAE calano di oltre la metà in un colpo solo non aggiorno (probabile errore)
  // controlli di salute (pagina admin → Stato)
  appUrl: "https://fedeopc.github.io/Cave-Informa/",
  bachecaCsv: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRJZXJKEyewVrHMYbJ4-22ceQiaA9FOSylEEp2Sm6Xxjbw8BSiYP6kDrFe1VM45ZzoM7fUhppEaiXPZ/pub?gid=1840933248&single=true&output=csv",
  // Regione Lazio: allertamenti e bollettini di criticità (PDF), di solito pubblicati prima del bollettino nazionale
  lazioZona: "G",                       // G = Bacino del Liri nelle tabelle della Regione
  lazioPagine: [
    ["allertamento", "https://www.regione.lazio.it/protezione-civile/centro-funzionale-regionale/bollettini-allertamenti", /allertamentiregionali-allegati\/[^"'<>]+\.pdf/i],
    ["bollettino", "https://www.regione.lazio.it/protezione-civile/centro-funzionale-regionale/bollettini-criticita-idrogeologica-idraulica", /criticita-idrogeologica\/[^"'<>]+\.pdf/i],
  ],
};

const PUSH_HOSTS = [/\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /\.mozilla\.com$/, /\.mozaws\.net$/, /\.notify\.windows\.com$/, /\.push\.services\.mozilla\.com$/];
const LEVEL_NAME = ["nessuna allerta", "allerta gialla", "allerta arancione", "allerta rossa"];

/* ---------------- utilità ---------------- */
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
async function sha256hex(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });

/* ---------------- chiavi VAPID (create al primo uso e salvate in KV) ---------------- */
async function vapidKeys(env) {
  const saved = await env.KV.get("vapid", "json");
  if (saved) return saved;
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = { publicKey: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
  await env.KV.put("vapid", JSON.stringify(keys));
  return keys;
}
const VAPID_CACHE = new Map(); // firma riutilizzata per lo stesso servizio (Apple, Google…) per un'ora: risparmia calcolo
async function vapidHeader(endpoint, keys, contact) {
  const aud = new URL(endpoint).origin;
  const hit = VAPID_CACHE.get(aud);
  if (hit && hit.exp > Date.now()) return hit.h;
  const h = await vapidHeaderNuovo(aud, keys, contact);
  VAPID_CACHE.set(aud, { h, exp: Date.now() + 3600e3 });
  return h;
}
async function vapidHeaderNuovo(aud, keys, contact) {
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact || "mailto:admin@example.org" })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

/* ---------------- cifratura del messaggio (RFC 8291, aes128gcm) ---------------- */
let EPH = null; // chiave temporanea del mittente, rinnovata ogni 5 minuti
async function effimera() {
  if (EPH && EPH.exp > Date.now()) return EPH;
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  EPH = { keys, pub: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)), exp: Date.now() + 300e3 };
  return EPH;
}
async function encryptPayload(sub, plaintext, testing) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const eph = testing?.asKeys ? { keys: testing.asKeys, pub: new Uint8Array(await crypto.subtle.exportKey("raw", testing.asKeys.publicKey)) } : await effimera();
  const asKeys = eph.keys, asPublic = eph.pub;
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const salt = testing?.salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

/* ---------------- invio ---------------- */
async function sendOne(env, keys, sub, payload, urgency) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(CFG.ttl), Urgency: urgency || "high", Authorization: await vapidHeader(sub.endpoint, keys, env.CONTACT) },
    body,
  });
  return r.status;
}
/* Invio a tutti gli iscritti.
   Il piano gratuito di Cloudflare permette ~50 collegamenti esterni e ~10 ms di calcolo per esecuzione:
   oltre pochi telefoni le notifiche vengono divise in gruppi da LOTTO, ognuno inviato da un'esecuzione separata
   del servizio stesso tramite il collegamento interno SELF (Impostazioni → Collegamenti → Servizio). */
const LOTTO = 8, LOCALE_MAX = 8, SENZA_SELF_MAX = 12;
async function lottoToken(env, keys) { return sha256hex("lotto:" + keys.privateJwk.d); }
async function inviaLotto(env, keys, lista, payload, urgency) {
  let sent = 0, removed = 0, failed = 0;
  await Promise.all(lista.map(async ({ k, sub }) => {
    try {
      const st = await sendOne(env, keys, sub, payload, urgency);
      if (st === 404 || st === 410) { await env.KV.delete(k); removed++; }
      else if (st >= 200 && st < 300) sent++;
      else failed++;
    } catch (e) { failed++; }
  }));
  return { sent, removed, failed };
}
async function broadcast(env, payload, urgency, filtro, noLog) {
  const keys = await vapidKeys(env);
  const dest = []; let cursor;
  do {
    const page = await env.KV.list({ prefix: "sub:", cursor });
    cursor = page.list_complete ? null : page.cursor;
    for (const k of page.keys) if (k.metadata && k.metadata.endpoint && (!filtro || filtro(k.metadata))) dest.push({ k: k.name, sub: k.metadata });
  } while (cursor);
  let tot = { sent: 0, removed: 0, failed: 0 }, nonInviati = 0, lotti = 0;
  const somma = (r) => { tot.sent += r.sent; tot.removed += r.removed; tot.failed += r.failed; };
  if (dest.length <= LOCALE_MAX) somma(await inviaLotto(env, keys, dest, payload, urgency));
  else if (env.SELF) {
    const token = await lottoToken(env, keys), gruppi = [];
    for (let i = 0; i < dest.length; i += LOTTO) gruppi.push(dest.slice(i, i + LOTTO));
    lotti = gruppi.length;
    await Promise.all(gruppi.map(async (g) => {
      try {
        const r = await env.SELF.fetch("https://interno/invia-lotto", { method: "POST", headers: { "Content-Type": "application/json", "X-Lotto": token }, body: JSON.stringify({ payload, urgency, lista: g }) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        somma(await r.json());
      } catch (e) { tot.failed += g.length; }
    }));
  } else {
    // collegamento SELF non configurato: invio solo ai primi, per non bloccare il servizio, e lo segnalo nella pagina admin
    for (let i = 0; i < Math.min(dest.length, SENZA_SELF_MAX); i += LOCALE_MAX) somma(await inviaLotto(env, keys, dest.slice(i, i + LOCALE_MAX), payload, urgency));
    nonInviati = Math.max(0, dest.length - SENZA_SELF_MAX);
  }
  if (!noLog && (tot.sent || tot.failed || tot.removed || nonInviati)) await env.KV.put("ultimo-invio", JSON.stringify({ at: new Date().toISOString(), title: payload.title, ...tot, nonInviati, lotti }));
  return { ...tot, nonInviati, lotti };
}

/* ---------------- bollettino di criticità ---------------- */
// Legge il testo del bollettino: titoli "… PER RISCHIO X / ALLERTA COLORE:" seguiti da righe "<b>Regione</b>: zona, zona"
function parseBulletinText(html, regione, zona) {
  const res = { max: 0, risks: [] };
  const parts = html.split(/<b>([^<]*ALLERTA[^<]*)<\/b>/i);
  for (let i = 1; i < parts.length; i += 2) {
    const head = parts[i], body = parts[i + 1] || "";
    const lvl = /ROSSA/i.test(head) ? 3 : /ARANCIONE/i.test(head) ? 2 : /GIALLA/i.test(head) ? 1 : 0;
    const risk = (head.match(/RISCHIO\s+([A-ZÀ-Ü]+)/i) || [])[1] || "";
    const re = new RegExp("<b>\\s*" + regione + "\\s*</b>\\s*:([^<]*)", "i");
    const m = body.match(re);
    if (m && m[1].split(",").map((s) => s.trim().toLowerCase()).includes(zona.toLowerCase())) {
      res.risks.push({ lvl, risk: risk.toLowerCase() });
      if (lvl > res.max) res.max = lvl;
    }
  }
  return res;
}
async function latestStem(env) {
  const h = { "User-Agent": "cave-informa-push", Accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) h.Authorization = "Bearer " + env.GITHUB_TOKEN;
  const list = await (await fetch(`https://api.github.com/repos/${CFG.bcrRepo}/commits?path=files/topojson&per_page=1`, { headers: h })).json();
  const det = await (await fetch(`https://api.github.com/repos/${CFG.bcrRepo}/commits/${list[0].sha}`, { headers: h })).json();
  const f = (det.files || []).map((x) => x.filename).find((n) => /\d{8}_\d{4}/.test(n));
  return f.match(/(\d{8}_\d{4})/)[1];
}
const fmtDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 12)).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Rome" });
const romeYmd = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }).replace(/-/g, "");
function addDay(ymd) { const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + 1)); return d.toISOString().slice(0, 10).replace(/-/g, ""); }

// notifica un cambio di livello per un giorno; usata sia dal bollettino nazionale sia da quello della Regione:
// chi arriva prima notifica, l'altro non ripete la notifica se il livello è lo stesso
async function notifyLevel(env, date, max, risks, fonte) {
  const key = "notificato:" + date;
  const prev = +(await env.KV.get(key) || 0);
  const when = date === romeYmd() ? "oggi" : "domani";
  const Liv = (n) => LEVEL_NAME[n][0].toUpperCase() + LEVEL_NAME[n].slice(1);
  const soloGialla = (sub) => sub.g === 1; // chi ha scelto "avvisami anche per l'allerta gialla"
  const da = fonte ? ` Fonte: ${fonte}.` : "";
  let res = null;
  // dopo le 21 niente notifiche per la giornata in corso, tranne quando sale ad arancione o rossa
  const ora = +new Date().toLocaleString("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Rome" });
  const tardi = date === romeYmd() && ora >= 21 && !(max >= 2 && max > prev);
  if (tardi) { /* solo memorizzo il livello */ }
  else if (max >= 1 && max > prev) {
    // arancione e rossa a tutti; gialla solo a chi l'ha chiesta
    res = await broadcast(env, {
      title: `${max >= 2 ? "⚠️" : "🟡"} ${Liv(max)} ${when} a ${CFG.comune}`,
      body: `${fmtDate(date)}: ${LEVEL_NAME[max]} per rischio ${risks} (zona ${CFG.zona}). Segui le indicazioni delle autorità.${da}`,
      url: "./#allerte", tag: "allerta-" + date,
    }, max >= 2 ? "high" : "normal", max >= 2 ? null : soloGialla);
  } else if (max < prev) {
    const rientrata = max === 0;
    res = await broadcast(env, {
      title: rientrata ? `Allerta rientrata ${when} a ${CFG.comune}` : `Allerta abbassata ${when} a ${CFG.comune}`,
      body: (rientrata ? `${fmtDate(date)}: nessuna allerta (prima era ${LEVEL_NAME[prev]}).` : `${fmtDate(date)}: ora ${LEVEL_NAME[max]} (prima era ${LEVEL_NAME[prev]}).`) + da,
      url: "./#allerte", tag: "allerta-" + date,
    }, "normal", prev >= 2 ? null : soloGialla);
  }
  if (max !== prev) await env.KV.put(key, String(max), { expirationTtl: 4 * 86400 });
  return res;
}

async function checkAlerts(env, force) {
  const stem = await latestStem(env);
  const last = await env.KV.get("ultimo-bollettino");
  if (stem === last && !force) return { stem, changed: false };
  const idx = await (await fetch(`https://raw.githubusercontent.com/${CFG.bcrRepo}/master/files/${stem}.json`)).json();
  const d0 = stem.slice(0, 8), d1 = addDay(d0), today = romeYmd();
  const out = [];
  for (const [date, part] of [[d0, idx.today], [d1, idx.tomorrow]]) {
    if (!part || date < today) continue;
    const r = parseBulletinText(part.html_descrition || part.html_description || "", CFG.regione, CFG.zona);
    const risks = [...new Set(r.risks.filter((x) => x.lvl === r.max).map((x) => x.risk))].join(", ");
    out.push(await notifyLevel(env, date, r.max, risks, ""));
  }
  await env.KV.put("ultimo-bollettino", stem);
  return { stem, changed: true, out };
}

/* ---------------- lettura del testo dei PDF (solo ciò che serve: testo delle pagine) ---------------- */
const latin1 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; };
async function inflate(u8) {
  const ds = new DecompressionStream("deflate");
  const w = ds.writable.getWriter(); w.write(u8).catch(() => {}); w.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
async function pdfText(buf) {
  const u8 = new Uint8Array(buf), objs = new Map();
  let s; try { s = new TextDecoder("windows-1252").decode(u8); if (s.length !== u8.length) throw 0; } catch (e) { s = latin1(u8); } // 1 carattere per byte
  for (const m of s.matchAll(/(\d+)\s+0\s+obj\b/g)) {
    const at = m.index + m[0].length, si = s.indexOf("stream", at), ei = s.indexOf("endobj", at);
    if (si >= 0 && si < ei && !/end$/.test(s.slice(si - 3, si))) {
      const dict = s.slice(at, si), nl = s[si + 6] === "\r" ? 8 : 7, lm = dict.match(/\/Length\s+(\d+)(?!\s+0\s+R)/);
      const end = lm ? si + nl + +lm[1] : s.lastIndexOf("endstream", ei);
      objs.set(+m[1], { dict, a: si + nl, b: end });
    } else objs.set(+m[1], { dict: s.slice(at, ei) });
  }
  const data = async (o) => {
    if (!o || o.a == null) return "";
    if (o.txt == null) { let b = u8.subarray(o.a, o.b); if (/\/FlateDecode/.test(o.dict)) { try { b = await inflate(b); } catch (e) { b = new Uint8Array(); } } o.txt = latin1(b); }
    return o.txt;
  };
  for (const [, o] of [...objs]) if (/\/Type\s*\/ObjStm/.test(o.dict)) { // oggetti compressi
    const d = await data(o), n = +o.dict.match(/\/N\s+(\d+)/)[1], first = +o.dict.match(/\/First\s+(\d+)/)[1], h = d.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) if (!objs.has(h[2 * i])) objs.set(h[2 * i], { dict: d.slice(first + h[2 * i + 1], i + 1 < n ? first + h[2 * i + 3] : d.length) });
  }
  const get = (n) => objs.get(+n);
  const val = (dict, key) => { const m = dict.match(new RegExp("/" + key + "\\s*(\\d+\\s+0\\s+R|<<(?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*>>|\\[[^\\]]*\\])")); if (!m) return ""; const r = m[1].match(/^(\d+)\s+0\s+R/); return r ? (get(r[1])?.dict || "") : m[1]; };
  const cmaps = new Map();
  const cmapOf = async (fd) => {
    const m = (fd || "").match(/\/ToUnicode\s+(\d+)\s+0\s+R/); if (!m) return null;
    if (cmaps.has(m[1])) return cmaps.get(m[1]);
    const d = await data(get(m[1])), map = new Map(); let len = 2;
    const u = (h) => { let t = ""; for (let i = 0; i < h.length; i += 4) t += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return t; };
    for (const b of d.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const x of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) { len = x[1].length / 2; map.set(parseInt(x[1], 16), u(x[2])); }
    for (const b of d.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const x of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      len = x[1].length / 2; const lo = parseInt(x[1], 16), hi = parseInt(x[2], 16);
      if (x[3][0] === "[") { const arr = [...x[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((y) => u(y[1])); for (let c = lo; c <= hi; c++) map.set(c, arr[c - lo] || ""); }
      else { const base = x[3].slice(1, -1), bv = parseInt(base.slice(-4), 16), pre = u(base.slice(0, -4)); for (let c = lo; c <= hi; c++) map.set(c, pre + String.fromCharCode(bv + c - lo)); }
    }
    const r = { map, len }; cmaps.set(m[1], r); return r;
  };
  const decode = (bytes, cm) => { if (!cm) return bytes.replace(/[^\x20-\x7e\xa0-\xff]/g, ""); let t = ""; for (let i = 0; i + cm.len <= bytes.length; i += cm.len) { let c = 0; for (let k = 0; k < cm.len; k++) c = c * 256 + bytes.charCodeAt(i + k); t += cm.map.get(c) ?? ""; } return t; };
  const lit = (x) => x.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, e) => /[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[e] ?? e);
  const hex = (h) => { h = h.replace(/\s/g, ""); if (h.length % 2) h += "0"; let t = ""; for (let i = 0; i < h.length; i += 2) t += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return t; };
  const pages = [];
  const walk = (d, depth = 0) => { if (depth > 10) return; if (/\/Type\s*\/Pages\b/.test(d)) { for (const k of ((d.match(/\/Kids\s*\[([^\]]*)\]/) || [])[1] || "").matchAll(/(\d+)\s+0\s+R/g)) walk(get(k[1])?.dict || "", depth + 1); } else if (/\/Type\s*\/Page\b/.test(d)) pages.push(d); };
  const root = [...s.matchAll(/\/Root\s+(\d+)\s+0\s+R/g)].pop();
  if (!root) throw new Error("PDF non leggibile");
  walk(val(get(root[1])?.dict || "", "Pages"));
  const RE = /\/([^\s/<>\[\]()]+)\s+[\d.]+\s+Tf|\((?:\\.|[^\\)])*\)\s*Tj|<[0-9a-fA-F\s]*>\s*Tj|\[((?:\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|[^\]])*)\]\s*TJ|\bBT\b|\bET\b|\/([^\s/<>\[\]()]+)\s+Do\b/g;
  const out = [];
  async function run(content, res, items, depth) {
    const fonts = val(res, "Font"), xo = val(res, "XObject"), fmap = {}, xmap = {};
    for (const f of fonts.matchAll(/\/([^\s/<>\[\]]+)\s+(\d+)\s+0\s+R/g)) fmap[f[1]] = get(f[2])?.dict || "";
    for (const f of xo.matchAll(/\/([^\s/<>\[\]]+)\s+(\d+)\s+0\s+R/g)) xmap[f[1]] = get(f[2]);
    let font = null, cur = "";
    for (const m of content.matchAll(RE)) {
      const t = m[0];
      if (t === "BT") cur = "";
      else if (t === "ET") { if (cur.trim()) items.push(cur.trim()); cur = ""; }
      else if (m[3]) { const x = xmap[m[3]]; if (x && depth < 4 && /\/Subtype\s*\/Form/.test(x.dict)) await run(await data(x), val(x.dict, "Resources") || res, items, depth + 1); }
      else if (m[1]) font = await cmapOf(fmap[m[1]]);
      else if (/TJ$/.test(t)) { for (const p of m[2].matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]*)>|(-?[\d.]+)/g)) { if (p[1] != null) cur += decode(lit(p[1]), font); else if (p[2] != null) cur += decode(hex(p[2]), font); else if (+p[3] < -200) cur += " "; } }
      else if (t[0] === "(") cur += decode(lit(t.slice(1, t.lastIndexOf(")"))), font);
      else cur += decode(hex(t.slice(1, t.indexOf(">"))), font);
    }
  }
  for (const pg of pages.slice(0, 6)) {
    const items = [], cm = (pg.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/) || [])[1] || "";
    let content = ""; for (const r of cm.matchAll(/(\d+)\s+0\s+R/g)) content += (await data(get(r[1]))) + "\n";
    await run(content, val(pg, "Resources"), items, 0);
    out.push(items);
  }
  return out;
}

/* tabelle "Valutazioni per OGGI/DOMANI, gg/mm/aaaa": riga = zona (A–G) + 3 colori (idrogeologica, temporali, idraulica) */
const COL = { VERDE: 0, GIALLO: 1, GIALLA: 1, ARANCIONE: 2, ROSSO: 3, ROSSA: 3 };
function parseLazioTables(pages) {
  const it = pages.flat().map((x) => x.replace(/\s+/g, " ").trim().toUpperCase());
  const giorni = {};
  for (let i = 0; i < it.length; i++) {
    const d = it[i].match(/\b(OGGI|DOMANI)\b,?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!d) continue;
    const ymd = d[4] + d[3].padStart(2, "0") + d[2].padStart(2, "0"), zone = {};
    for (let j = i + 1; j < it.length && j < i + 80 && Object.keys(zone).length < 7; j++) {
      if (/^[A-G]$/.test(it[j]) && [1, 2, 3].every((k) => it[j + k] in COL)) { zone[it[j]] = [1, 2, 3].map((k) => COL[it[j + k]]); j += 3; }
      else if (/\b(OGGI|DOMANI)\b,?\s*\d/.test(it[j])) break;
    }
    if (Object.keys(zone).length === 7) giorni[ymd] = zone;
  }
  return giorni;
}


const RISCHI_LAZIO = ["idrogeologico", "temporali", "idraulico"];
async function checkLazio(env, force) {
  const now = new Date().toISOString(), today = romeYmd(), esiti = [];
  const stato = JSON.parse(JSON.stringify((await env.KV.get("lazio", "json")) || { giorni: {} }));
  for (const [tipo, pagina, re] of CFG.lazioPagine) {
    try {
      const html = await (await fetch(pagina, { headers: { "User-Agent": "Mozilla/5.0 (cave-informa)" } })).text();
      const m = html.match(re);
      if (!m) throw new Error("nessun PDF trovato nella pagina della Regione");
      const url = new URL(m[0].replace(/&amp;/g, "&"), "https://www.regione.lazio.it/sites/default/files/").href;
      if (!force && await env.KV.get("lazio-letto:" + url)) { esiti.push({ tipo, ok: true, nuovo: false }); continue; }
      // protezione: se la lettura si interrompe (PDF troppo pesante) dopo 3 tentativi il PDF viene saltato
      const tk = "lazio-tentativi:" + url, tent = +(await env.KV.get(tk) || 0);
      if (tent >= 3 && !force) throw new Error("PDF non leggibile dal servizio (saltato): " + url.split("/").pop());
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (cave-informa)" } });
      if (!r.ok) throw new Error("PDF non scaricabile (HTTP " + r.status + ")");
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 4e6) throw new Error("PDF troppo grande");
      await env.KV.put(tk, String(tent + 1), { expirationTtl: 10 * 86400 }); // conto solo i tentativi di lettura
      const giorni = parseLazioTables(await pdfText(buf));
      const date = Object.keys(giorni).sort();
      await env.KV.put("lazio-letto:" + url, "1", { expirationTtl: 10 * 86400 });
      if (!date.length) { esiti.push({ tipo, ok: true, nuovo: true, url, note: "senza tabella delle zone (per esempio solo vento)" }); continue; }
      for (const d of date) {
        const lv = giorni[d][CFG.lazioZona], max = Math.max(...lv);
        if (!stato.giorni[d] || stato.giorni[d].emesso <= now) stato.giorni[d] = { livelli: lv, max, tipo, url, emesso: now };
        if (d < today) continue;
        const risks = RISCHI_LAZIO.filter((x, i) => lv[i] === max && max > 0).join(", ");
        await notifyLevel(env, d, max, risks, "Regione Lazio");
      }
      esiti.push({ tipo, ok: true, nuovo: true, url, giorni: date.map((d) => d + ":" + giorni[d][CFG.lazioZona].join("")) });
    } catch (e) { esiti.push({ tipo, ok: false, errore: String(e.message || e) }); }
  }
  for (const d of Object.keys(stato.giorni)) if (d < today) delete stato.giorni[d]; // tengo solo oggi e domani
  // salvo solo se i livelli sono cambiati (limite di 1000 salvataggi al giorno del piano gratuito)
  const prima = await env.KV.get("lazio");
  if (!prima || JSON.stringify(JSON.parse(prima).giorni) !== JSON.stringify(stato.giorni)) { stato.aggiornato = now; await env.KV.put("lazio", JSON.stringify(stato)); }
  return esiti;
}

/* ---------------- terremoti INGV ---------------- */
function km(a, b) { const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
async function checkQuakes(env) {
  const start = new Date(Date.now() - 2 * 3600e3).toISOString().slice(0, 19);
  const url = `https://webservices.ingv.it/fdsnws/event/1/query?starttime=${start}&lat=${CFG.lat}&lon=${CFG.lon}&maxradiuskm=${CFG.eqRadiusKm}&minmag=${CFG.eqMinMag}&format=text&orderby=time`;
  const r = await fetch(url);
  if (r.status === 204) return [];
  const txt = await r.text();
  const out = [];
  for (const line of txt.split("\n")) {
    if (!line || line[0] === "#") continue;
    const c = line.split("|");
    const ev = { id: c[0], time: new Date(/Z$/.test(c[1]) ? c[1] : c[1] + "Z"), lat: +c[2], lon: +c[3], mag: +c[10], place: c[12] };
    if (!ev.id || !isFinite(ev.mag)) continue;
    if (await env.KV.get("eq:" + ev.id)) continue;
    await env.KV.put("eq:" + ev.id, "1", { expirationTtl: 7 * 86400 });
    const d = Math.round(km(CFG, ev));
    const ora = ev.time.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });
    out.push(await broadcast(env, {
      title: `Terremoto magnitudo ${ev.mag.toFixed(1)} a ${d} km da ${CFG.comune}`,
      body: `${ev.place}, ore ${ora}. Stima INGV, può essere aggiornata.`,
      url: "./#terremoti", tag: "eq-" + ev.id,
    }));
  }
  return out;
}

/* ---------------- defibrillatori: lettura della mappa della Croce Rossa ---------------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEnt = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
const kmlText = (t) => decodeEnt(String(t || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const kmlTag = (xml, t) => { const m = xml.match(new RegExp("<" + t + "\\b[^>]*>([\\s\\S]*?)</" + t + ">", "i")); return m ? m[1] : ""; };
function parseKml(kml) {
  const out = [];
  for (const m of kml.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/gi)) {
    const point = kmlTag(m[0], "Point"); if (!point) continue;
    const [lon, lat] = kmlTag(point, "coordinates").trim().split(/[\s,]+/).map(Number);
    if (!isFinite(lat) || !isFinite(lon) || km(CFG, { lat, lon }) > CFG.daeMaxKm) continue;
    const nome = kmlText(kmlTag(m[0], "name")).slice(0, 120) || "Defibrillatore";
    const descrizione = kmlText(kmlTag(m[0], "description")).slice(0, 300);
    out.push({ nome, lat: +lat.toFixed(7), lon: +lon.toFixed(7), ...(descrizione ? { descrizione } : {}) });
  }
  return out;
}
async function checkDae(env) {
  const now = new Date().toISOString();
  try {
    const r = await fetch(`https://www.google.com/maps/d/kml?mid=${CFG.daeMapId}&forcekml=1`, { headers: { "User-Agent": "cave-informa-dae" } });
    if (!r.ok) throw new Error("mappa non raggiungibile (HTTP " + r.status + ")");
    const kml = await r.text();
    if (!/<kml\b/i.test(kml)) throw new Error("la risposta non è una mappa KML (la mappa è ancora pubblica?)");
    const dae = parseKml(kml);
    const prev = await env.KV.get("dae", "json");
    const prevN = prev?.dae?.length || 0;
    if (!dae.length) throw new Error("nessun DAE trovato sulla mappa: elenco non aggiornato");
    if (prevN && dae.length < prevN * CFG.daeMinRatio) throw new Error(`DAE scesi da ${prevN} a ${dae.length}: elenco non aggiornato per sicurezza`);
    if (!prev || JSON.stringify(prev.dae) !== JSON.stringify(dae)) {
      await env.KV.put("dae", JSON.stringify({ fonte: "Croce Rossa Italiana - Comitato di Monti Prenestini-ODV", mappa: `https://www.google.com/maps/d/viewer?mid=${CFG.daeMapId}`, aggiornato: now, dae }));
    }
    return { ok: true, n: dae.length };
  } catch (e) {
    return { ok: false, errore: String(e.message || e) };
  }
}

/* ---------------- avvisi dell'associazione ---------------- */
async function getAvvisi(env) { return (await env.KV.get("avvisi", "json")) || []; }
const romeIso = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }); // AAAA-MM-GG
// visibile nella bacheca pubblica: già pubblicato e non scaduto
const visibile = (a) => !a.programmato && !(a.fino && a.fino < romeIso());
async function notificaAvviso(env, avviso) {
  const icon = avviso.tipo === "urgente" ? "⚠️ " : avviso.tipo === "evento" ? "📅 " : "📢 ";
  const quando = avviso.tipo === "evento" ? fmtDate(avviso.giorno.replace(/-/g, "")) + (avviso.ora ? ", ore " + avviso.ora : "") + (avviso.luogo ? " · " + avviso.luogo : "") + ". " : "";
  return broadcast(env, { title: icon + avviso.titolo, body: (quando + avviso.testo).slice(0, 180) || "Comunicazione dell'associazione", url: "./#bacheca", tag: "avviso-" + avviso.id }, avviso.tipo === "urgente" ? "high" : "normal");
}
// pubblicazione degli avvisi programmati (dal controllo ogni 10 minuti)
async function pubblicaProgrammati(env) {
  const list = await getAvvisi(env), ora = Date.now();
  const pronti = list.filter((a) => a.programmato && Date.parse(a.data) <= ora);
  if (!pronti.length) return 0;
  const nuova = list.map((a) => { if (!pronti.includes(a)) return a; const { programmato, notifica, ...r } = a; return r; });
  await env.KV.put("avvisi", JSON.stringify(nuova));
  for (const a of pronti) if (a.notifica) await notificaAvviso(env, a);
  return pronti.length;
}

/* ---------------- amministratori ----------------
   - amministratore principale: la password ADMIN_TOKEN (nome mostrato: ADMIN_NAME, se impostato)
   - altre persone: codici personali creati dall'amministratore principale, salvati in KV solo come impronta (hash) */
const ipOf = (req) => req.headers.get("CF-Connecting-IP") || "?";
// contatori temporanei (tentativi sbagliati, iscrizioni) nella cache di Cloudflare: non consumano i salvataggi giornalieri
const MEM = new Map();
async function contatore(chiave, secondi, incrementa) {
  const url = "https://contatori.cave-informa/" + encodeURIComponent(chiave);
  let n = 0, cache = null;
  try { cache = caches.default; const r = await cache.match(url); if (r) n = +(await r.text()) || 0; }
  catch (e) { const m = MEM.get(chiave); n = m && m.exp > Date.now() ? m.n : 0; }
  if (incrementa) {
    n++;
    if (cache) { try { await cache.put(url, new Response(String(n), { headers: { "Cache-Control": "max-age=" + secondi } })); } catch (e) {} }
    else { const m = MEM.get(chiave); MEM.set(chiave, { n, exp: m && m.exp > Date.now() ? m.exp : Date.now() + secondi * 1000 }); }
  }
  return n;
}
function uguali(a, b) { // confronto a tempo costante
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0;
}
async function getCodici(env) { return (await env.KV.get("codici", "json")) || []; }
async function auth(req, env) {
  const a = req.headers.get("Authorization") || "";
  const tok = a.startsWith("Bearer ") ? a.slice(7).trim() : "";
  const failKey = "fail:" + ipOf(req);
  const fails = await contatore(failKey, 900, false);
  if (fails >= 10) return { blocked: true };
  if (!tok) return null;
  if (env.ADMIN_TOKEN && uguali(tok, env.ADMIN_TOKEN)) return { ruolo: "principale", nome: env.ADMIN_NAME || "Amministratore principale", id: "principale" };
  const h = await sha256hex("codice:" + tok.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  const list = await getCodici(env);
  const c = list.find((x) => x.hash === h);
  if (c) {
    if (!c.ultimoUso || Date.now() - Date.parse(c.ultimoUso) > 3600e3) { c.ultimoUso = new Date().toISOString(); await env.KV.put("codici", JSON.stringify(list)); }
    return { ruolo: "volontario", nome: c.nome, id: c.id };
  }
  await contatore(failKey, 900, true); // troppi tentativi sbagliati: blocco di 15 minuti
  return null;
}
const denied = (u) => u && u.blocked ? json({ error: "troppi tentativi sbagliati: riprova tra 15 minuti" }, 429) : json({ error: "codice non valido" }, 401);
function nuovoCodice() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(12));
  return [...r].map((x) => a[x % a.length]).join("").replace(/(.{4})(?=.)/g, "$1-");
}
const TIPI = ["avviso", "urgente", "evento"];
const isoDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));


async function contaIscritti(env) { let n = 0, cursor; do { const p = await env.KV.list({ prefix: "sub:", cursor }); n += p.keys.length; cursor = p.list_complete ? null : p.cursor; } while (cursor); return n; }

/* ---------------- area soci ----------------
   I soci hanno un codice personale (diverso da quello dei volontari: non entra nella pagina admin).
   Con il codice attivano il telefono una volta: il servizio dà al telefono un "gettone" (non il codice) e segna
   l'iscrizione alle notifiche come socio. Le attivazioni partono dalla pagina admin; ogni socio può rispondere
   "Ci sono / Non posso" con una nota. Ogni risposta è salvata in una chiave sua, così risposte contemporanee non si perdono. */
async function getSoci(env) { return (await env.KV.get("soci", "json")) || []; }
async function getSociMsg(env) { return (await env.KV.get("soci-msg", "json")) || []; }
const normCod = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// un solo telefono per codice socio: s.tel = telefono attivo, s.attesa = nuovo telefono in attesa di approvazione
async function socioDaToken(env, token) {
  if (typeof token !== "string" || token.length < 20) return null;
  const th = await sha256hex(token), id = await env.KV.get("socio-tok:" + th);
  if (!id) return null;
  const list = await getSoci(env), s = list.find((x) => x.id === id);
  if (!s) return null; // codice revocato: il gettone non vale più
  if (s.attesa && s.attesa.t === th) return { ...s, inAttesa: true };
  if (!s.tel) { s.tel = { t: th, e: null, at: new Date().toISOString() }; await env.KV.put("soci", JSON.stringify(list)); return s; } // attivazioni precedenti a questa regola
  return s.tel.t === th ? s : null; // telefono scollegato o sostituito
}
async function getRegola(env) { return (await env.KV.get("soci-regola")) || "approva"; }
async function scollega(env, s) { // toglie il telefono attivo del socio
  if (!s.tel) return;
  await env.KV.delete("socio-tok:" + s.tel.t);
  if (s.tel.e) { const cur = await env.KV.getWithMetadata(s.tel.e); if (cur.metadata && cur.metadata.m === s.id) { const { m, ...md } = cur.metadata; await env.KV.put(s.tel.e, "1", { metadata: md }); } }
  delete s.tel;
}
async function collega(env, s, th, sk) { // rende attivo il telefono (gettone th, iscrizione sk)
  if (s.tel && s.tel.e !== sk) await scollega(env, s);
  const cur = await env.KV.getWithMetadata(sk);
  if (cur.metadata) await env.KV.put(sk, "1", { metadata: { ...cur.metadata, m: s.id } });
  await env.KV.put("socio-tok:" + th, s.id);
  s.tel = { t: th, e: sk, at: new Date().toISOString() }; delete s.attesa;
}
async function avvisoAdmin(env, title, body) { // ai telefoni degli amministratori con la spunta "Avvisami"
  try { await broadcast(env, { title, body, url: "./admin.html", tag: "soci-tel" }, "normal", (sub) => sub.a === 1, true); } catch (e) {}
}
async function dispositiviSoci(env) { // quanti telefoni e quanti soci diversi hanno l'area soci attiva
  const ids = new Set((await getSoci(env)).map((x) => x.id)), per = new Set(); let tel = 0, cursor;
  do { const p = await env.KV.list({ prefix: "sub:", cursor }); cursor = p.list_complete ? null : p.cursor; for (const k of p.keys) if (k.metadata && ids.has(k.metadata.m)) { tel++; per.add(k.metadata.m); } } while (cursor);
  return { telefoni: tel, soci: per.size, totale: ids.size };
}
async function rispostePer(env, msgId) {
  const out = []; let cursor;
  do { const p = await env.KV.list({ prefix: "risp:" + msgId + ":", cursor }); cursor = p.list_complete ? null : p.cursor; for (const k of p.keys) if (k.metadata) out.push({ socio: k.name.split(":")[2], ...k.metadata }); } while (cursor);
  return out;
}
async function sociPubblico(req, env, url) {
  const body = (await req.json().catch(() => null)) || {};
  if (url.pathname === "/soci/attiva") {
    if (await contatore("soci:" + ipOf(req), 900, false) >= 10) return json({ error: "troppi tentativi sbagliati: riprova tra 15 minuti" }, 429);
    const h = await sha256hex("socio:" + normCod(body.codice));
    const list = await getSoci(env), s = list.find((x) => x.hash === h);
    if (!s) { await contatore("soci:" + ipOf(req), 900, true); return json({ error: "codice socio non valido" }, 401); }
    if (typeof body.endpoint !== "string") return json({ error: "attiva prima le notifiche su questo telefono" }, 400);
    const sk = "sub:" + await sha256hex(body.endpoint), cur = await env.KV.getWithMetadata(sk);
    if (!cur.metadata) return json({ error: "attiva prima le notifiche su questo telefono" }, 400);
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join(""), th = await sha256hex(token);
    s.ultimoUso = new Date().toISOString();
    if (!s.tel || !s.tel.e || s.tel.e === sk) { // primo telefono, o stesso telefono che si riattiva
      await collega(env, s, th, sk); await env.KV.put("soci", JSON.stringify(list));
      return json({ token, nome: s.nome });
    }
    const regola = await getRegola(env);
    if (regola === "blocca") return json({ error: "Questo codice è già attivo su un altro telefono. Chiedi all'amministratore di scollegarlo, poi riprova." }, 409);
    if (regola === "sostituisci") {
      await collega(env, s, th, sk); await env.KV.put("soci", JSON.stringify(list));
      await avvisoAdmin(env, "🔑 Area soci: nuovo telefono per " + s.nome, "Il codice di " + s.nome + " è stato attivato su un nuovo telefono; il precedente è stato scollegato. Se non è stato lui, revoca il codice.");
      return json({ token, nome: s.nome });
    }
    // approvazione manuale
    if (s.attesa) await env.KV.delete("socio-tok:" + s.attesa.t);
    s.attesa = { t: th, e: sk, at: new Date().toISOString() };
    await env.KV.put("socio-tok:" + th, s.id); await env.KV.put("soci", JSON.stringify(list));
    await avvisoAdmin(env, "🔑 " + s.nome + " chiede un nuovo telefono", "Il codice di " + s.nome + " è stato inserito su un altro telefono. Approva o rifiuta nella pagina admin, scheda Persone.");
    return json({ token, nome: s.nome, attesa: true });
  }
  const s = await socioDaToken(env, body.token);
  if (!s) return json({ error: "area soci non attiva su questo telefono (codice revocato o telefono scollegato)" }, 401);
  if (s.inAttesa && url.pathname !== "/soci/esci") return json({ error: "in attesa di approvazione dell'amministratore", attesa: true, nome: s.nome }, 403);
  if (url.pathname === "/soci/esci") {
    const list = await getSoci(env), x = list.find((y) => y.id === s.id);
    if (s.inAttesa) { await env.KV.delete("socio-tok:" + x.attesa.t); delete x.attesa; }
    else await scollega(env, x);
    await env.KV.put("soci", JSON.stringify(list));
    return json({ ok: true });
  }
  if (url.pathname === "/soci/messaggi") {
    const msgs = (await getSociMsg(env)).slice(0, 10);
    const out = await Promise.all(msgs.map(async (m) => { const r = await env.KV.getWithMetadata("risp:" + m.id + ":" + s.id); return { id: m.id, titolo: m.titolo, testo: m.testo, data: m.data, autore: m.autore, conferma: m.conferma, risposta: r.metadata || null }; }));
    return json({ nome: s.nome, messaggi: out });
  }
  if (url.pathname === "/soci/rispondi") {
    const m = (await getSociMsg(env)).find((x) => x.id === body.id);
    if (!m) return json({ error: "messaggio non trovato" }, 404);
    if (!m.conferma) return json({ error: "per questo messaggio non è richiesta una risposta" }, 400);
    if (!["si", "no"].includes(body.r)) return json({ error: "risposta non valida" }, 400);
    const md = { r: body.r, nota: String(body.nota || "").trim().slice(0, 120), at: new Date().toISOString(), nome: s.nome };
    await env.KV.put("risp:" + m.id + ":" + s.id, "1", { metadata: md, expirationTtl: 60 * 86400 });
    return json({ ok: true, risposta: md });
  }
  return json({ error: "non trovato" }, 404);
}

/* ---------------- controlli di salute ----------------
   Un solo salvataggio per giro ("salute"): stato di ogni controllo e da quando è in errore.
   Se un problema dura più di un'ora, avviso gli amministratori che l'hanno chiesto (una volta al giorno per problema). */
const CTL = [
  ["giro", "Servizio", "Controllo automatico ogni 10 minuti"], ["notifiche", "Servizio", "Notifiche consegnate"], ["invio", "Servizio", "Invio a molti telefoni"],
  ["bollettino", "Dati letti", "Bollettino nazionale"], ["regione", "Dati letti", "Regione Lazio"], ["dae", "Dati letti", "Mappa DAE (Croce Rossa)"],
  ["sheet", "Fonti esterne", "Foglio Google della bacheca"], ["ingv", "Fonti esterne", "INGV terremoti"], ["meteo", "Fonti esterne", "Open-Meteo previsioni"], ["dpc", "Fonti esterne", "Dipartimento (GitHub)"],
  ["app", "App", "App pubblicata"], ["admin", "App", "Pagina admin pubblicata"],
];
const NOME = Object.fromEntries(CTL.map(([id, , n]) => [id, n]));
const minDa = (iso) => iso ? (Date.now() - Date.parse(iso)) / 60000 : 0;
const hm = (iso) => new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });
const durata = (iso) => { const m = Math.round(minDa(iso)); return m < 60 ? m + " min" : m < 2880 ? Math.round(m / 60) + " h" : Math.round(m / 1440) + " giorni"; };
async function prova(url, ms = 8000, check) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "cave-informa-controllo" }, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { ok: false, err: "HTTP " + r.status };
    if (check) { const t = await r.text(); const v = check(t); return v === false ? { ok: false, err: "risposta inattesa" } : { ok: true, v }; }
    try { await r.body?.cancel(); } catch (e) {}
    return { ok: true };
  } catch (e) { return { ok: false, err: e.name === "TimeoutError" ? "nessuna risposta" : String(e.message || e) }; }
}
async function patchSalute(env, id, stato, breve, testo) {
  const sa = (await env.KV.get("salute", "json")) || { c: {}, avvisati: {} };
  const p = sa.c[id];
  sa.c[id] = { stato, breve, testo, da: stato === "ok" ? null : (p && p.stato !== "ok" && p.da) || new Date().toISOString() };
  await env.KV.put("salute", JSON.stringify(sa));
}
async function runAll(env) {
  const prev = (await env.KV.get("salute", "json")) || { c: {}, avvisati: {} };
  const now = new Date().toISOString(), c = {};
  try { await pubblicaProgrammati(env); } catch (e) { console.log("programmati", e); }
  // andamento degli iscritti: un conteggio al giorno
  try {
    const st = (await env.KV.get("iscritti-storico", "json")) || [], oggi = romeIso();
    if (!st.length || st[st.length - 1].d !== oggi) { st.push({ d: oggi, n: await contaIscritti(env) }); await env.KV.put("iscritti-storico", JSON.stringify(st.slice(-365))); }
  } catch (e) { console.log("storico", e); }
  // un errore isolato non accende il semaforo: serve che si ripeta al controllo successivo (dopo 10 minuti)
  const set = (id, stato, breve, testo = "", soglia = 2) => {
    const p = prev.c[id] || {}, f = stato === "ok" ? 0 : (p.f || 0) + 1;
    const da = stato === "ok" ? null : p.da || now; // da quando è in errore (anche se ancora "isolato")
    // primo errore: semaforo giallo subito, con l'indicazione che verrà ricontrollato
    if (stato !== "ok" && f < soglia) c[id] = { stato: "warn", breve: "primo errore · ricontrollo tra 10 min", testo: (testo || breve) + " Primo errore: potrebbe risolversi da solo, il servizio ricontrolla tra 10 minuti.", da, f };
    else c[id] = { stato, breve, testo, da, f };
  };
  // terremoti (INGV)
  try { await checkQuakes(env); set("ingv", "ok", "risponde"); }
  catch (e) { set("ingv", "warn", "non risponde", "non risponde (" + (e.message || e) + "): l'app usa i dati EMSC come riserva."); }
  // bollettino nazionale (GitHub del Dipartimento)
  try { await checkAlerts(env); set("dpc", "ok", "risponde"); }
  catch (e) { set("dpc", "warn", "non risponde", "GitHub del Dipartimento non risponde (" + (e.message || e) + "): il bollettino nazionale non può essere letto."); }
  const stem = await env.KV.get("ultimo-bollettino");
  if (stem) {
    const ore = (Date.now() - Date.parse(`${stem.slice(0, 4)}-${stem.slice(4, 6)}-${stem.slice(6, 8)}T${stem.slice(9, 11)}:${stem.slice(11, 13)}:00+01:00`)) / 3600e3;
    const b = stem.slice(6, 8) + "/" + stem.slice(4, 6) + " ore " + stem.slice(9, 11) + ":" + stem.slice(11, 13);
    if (ore < 30) set("bollettino", "ok", b);
    else set("bollettino", ore < 48 ? "warn" : "ko", "fermo al " + b, `nessun bollettino nuovo da ${Math.round(ore)} ore (ultimo: ${b}). Controlla sul sito del Dipartimento se è uscito.`);
  } else set("bollettino", "warn", "non ancora letto", "il bollettino nazionale non è ancora stato letto.");
  // mappa DAE
  const d = await checkDae(env);
  if (d.ok) set("dae", "ok", d.n + " DAE · letta " + hm(now));
  else set("dae", "ko", "errore", d.errore + ". L'app mostra l'ultimo elenco valido.");
  // Regione Lazio
  try {
    const es = await checkLazio(env), ko = es.filter((x) => !x.ok);
    const g = [...new Map(es.flatMap((x) => x.giorni || []).map((x) => [x.slice(0, 8), x])).values()].sort();
    const lv = g.map((x) => x.slice(6, 8) + "/" + x.slice(4, 6) + " " + ["verde", "gialla", "arancione", "rossa"][Math.max(...x.slice(9).split("").map(Number))]).join(", ");
    if (!ko.length) set("regione", "ok", lv ? "nuovo PDF · " + lv : "letta " + hm(now));
    else set("regione", "ko", "errore", ko.map((x) => x.errore).join("; ") + ". Le notifiche arrivano comunque dal bollettino nazionale.");
  } catch (e) { set("regione", "ko", "errore", String(e.message || e)); }
  // fonti usate direttamente dall'app
  const sh = await prova(CFG.bachecaCsv, 8000, (t) => !/<html/i.test(t.slice(0, 200)));
  // come per il meteo: un limite (429) verso Cloudflare non riguarda i telefoni, che leggono il foglio direttamente
  if (!sh.ok && sh.err === "HTTP 429") set("sheet", "ok", "risponde ai telefoni (limite solo per il servizio)");
  else set("sheet", sh.ok ? "ok" : "warn", sh.ok ? "risponde" : "non risponde", sh.ok ? "" : `non risponde (${sh.err}): la bacheca dell'app mostra solo gli avvisi della pagina admin.`);
  const om = await prova(`https://api.open-meteo.com/v1/forecast?latitude=${CFG.lat}&longitude=${CFG.lon}&current=temperature_2m`);
  // HTTP 429 = Open-Meteo limita le richieste che arrivano da Cloudflare (indirizzi condivisi da molti siti):
  // l'app scarica le previsioni direttamente dal telefono, quindi per i cittadini funziona lo stesso
  if (!om.ok && om.err === "HTTP 429") set("meteo", "ok", "risponde ai telefoni (limite solo per il servizio)");
  else set("meteo", om.ok ? "ok" : "warn", om.ok ? "risponde" : "non risponde", om.ok ? "" : `non risponde (${om.err}): nell'app potrebbero non comparire le previsioni a 3 giorni.`);
  // app pubblicata: controllo una volta all'ora
  if (!prev.appAt || minDa(prev.appAt) >= 55 || !prev.c.app) {
    const a = await prova(CFG.appUrl + "index.html?c=" + Date.now(), 10000, (t) => (t.match(/Versione (\d+(?:\.\d+)?)/) || [])[1] || false);
    set("app", a.ok ? "ok" : "ko", a.ok ? "versione " + a.v : "non raggiungibile", a.ok ? "" : `l'app non risponde all'indirizzo ${CFG.appUrl} (${a.err}).`, 1);
    const ad = await prova(CFG.appUrl + "admin.html", 10000);
    set("admin", ad.ok ? "ok" : "warn", ad.ok ? "online" : "non raggiungibile", ad.ok ? "" : `la pagina admin non risponde (${ad.err}). Resta disponibile la pagina di riserva del servizio.`, 1);
    prev.appAt = now;
  } else { c.app = prev.c.app; c.admin = prev.c.admin; }
  // avviso agli amministratori: problemi che durano da più di un'ora, una volta al giorno ciascuno
  const oggi = romeYmd(), avvisati = Object.fromEntries(Object.entries(prev.avvisati || {}).filter(([, v]) => v === oggi));
  const nuovi = Object.entries(c).filter(([id, x]) => x.stato !== "ok" && (x.f || 0) >= 2 && minDa(x.da) >= 30 && avvisati[id] !== oggi);
  if (nuovi.length) {
    const [id, x] = nuovi[0];
    await broadcast(env, {
      title: `⚠️ Cave Informa: ${nuovi.length === 1 ? NOME[id].toLowerCase() + " non funziona" : nuovi.length + " problemi"}`,
      body: (nuovi.length === 1 ? `${x.testo} (da ${durata(x.da)})` : nuovi.map(([i]) => NOME[i]).join(", ") + ".") + " Apri la pagina admin per i dettagli.",
      url: "./admin.html", tag: "sorveglianza",
    }, "normal", (sub) => sub.a === 1, true);
    for (const [i] of nuovi) avvisati[i] = oggi;
  }
  await env.KV.put("salute", JSON.stringify({ giro: now, appAt: prev.appAt, c, avvisati }));
}
async function salute(env, iscritti = 0) {
  const sa = (await env.KV.get("salute", "json")) || { c: {} }, ui = await env.KV.get("ultimo-invio", "json");
  const c = { ...sa.c }, m = minDa(sa.giro);
  c.giro = !sa.giro ? { stato: "ko", breve: "mai eseguito", testo: "il controllo automatico non è ancora partito: controlla su Cloudflare il trigger ogni 10 minuti." }
    : m < 25 ? { stato: "ok", breve: durata(sa.giro).replace(/^0 min$/, "adesso") + (m >= 1 ? " fa" : "") }
    : { stato: m < 60 ? "warn" : "ko", breve: "fermo da " + durata(sa.giro), da: sa.giro, testo: `nessun controllo da ${durata(sa.giro)}: Cloudflare non esegue il servizio o non riesce a salvare (limite giornaliero raggiunto?). Notifiche e letture sono ferme.` };
  if (ui && ui.nonInviati) c.notifiche = { stato: "ko", breve: `ultima ${hm(ui.at)} · ${ui.nonInviati} non inviate`, testo: `l'ultima notifica (${hm(ui.at)}) non è partita per ${ui.nonInviati} telefoni: manca il collegamento SELF su Cloudflare (Impostazioni → Collegamenti → Servizio "allerta-cave-push", nome SELF).` };
  else if (!ui) c.notifiche = { stato: "ok", breve: "nessuna inviata" };
  else if (ui.failed && ui.failed >= ui.sent) c.notifiche = { stato: "ko", breve: `ultima ${hm(ui.at)} · ${ui.failed} non riuscite`, testo: `l'ultima notifica (${hm(ui.at)}) non è stata consegnata a ${ui.failed} telefoni su ${ui.sent + ui.failed}.` };
  else c.notifiche = { stato: ui.failed ? "warn" : "ok", breve: `ultima ${hm(ui.at)} · ${ui.sent} su ${ui.sent + ui.failed}`, testo: ui.failed ? `l'ultima notifica non è arrivata a ${ui.failed} telefoni.` : "" };
  c.invio = env.SELF ? { stato: "ok", breve: "a gruppi di " + LOTTO + " · collegamento SELF attivo" }
    : iscritti > SENZA_SELF_MAX ? { stato: "ko", breve: "manca il collegamento SELF", testo: `con ${iscritti} telefoni iscritti serve il collegamento SELF su Cloudflare, altrimenti le notifiche arrivano solo ai primi ${SENZA_SELF_MAX}.` }
    : { stato: iscritti > LOCALE_MAX ? "warn" : "ok", breve: "manca il collegamento SELF" + (iscritti > LOCALE_MAX ? "" : " (per ora non serve)"), testo: iscritti > LOCALE_MAX ? `aggiungi il collegamento SELF su Cloudflare: oltre ${SENZA_SELF_MAX} telefoni le notifiche non arriverebbero a tutti.` : "" };
  return { giro: sa.giro || null, controlli: CTL.filter(([id]) => c[id]).map(([id, gruppo, nome]) => ({ id, gruppo, nome, ...c[id], testo: c[id].testo ? c[id].testo + (c[id].da ? ` (da ${durata(c[id].da)})` : "") : "" })) };
}

/* ---------------- HTTP ---------------- */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (url.pathname === "/invia-lotto" && req.method === "POST") {
        // chiamata interna (gruppo di notifiche): accettata solo con il codice derivato dalla chiave privata del servizio
        const keys = await vapidKeys(env);
        if (!uguali(req.headers.get("X-Lotto") || "", await lottoToken(env, keys))) return json({ error: "non autorizzato" }, 403);
        const { payload, urgency, lista } = (await req.json().catch(() => null)) || {};
        if (!payload || !Array.isArray(lista) || lista.length > 50) return json({ error: "richiesta non valida" }, 400);
        return json(await inviaLotto(env, keys, lista.filter((x) => x && typeof x.k === "string" && x.k.startsWith("sub:") && x.sub && x.sub.endpoint), payload, urgency));
      }
      if (["/soci/attiva", "/soci/esci", "/soci/messaggi", "/soci/rispondi"].includes(url.pathname) && req.method === "POST") return sociPubblico(req, env, url);
      if (url.pathname === "/lazio") return json((await env.KV.get("lazio", "json")) || { giorni: {} }); // livelli della Regione per la zona di Cave
      if (url.pathname === "/vapid") return json({ publicKey: (await vapidKeys(env)).publicKey });

      if (url.pathname === "/subscribe" && req.method === "POST") {
        const sub = await req.json().catch(() => null);
        if (!sub || typeof sub.endpoint !== "string") return json({ error: "iscrizione non valida" }, 400);
        const host = new URL(sub.endpoint).hostname;
        if (!/^https:/.test(sub.endpoint) || !PUSH_HOSTS.some((re) => re.test(host)) || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "iscrizione non valida" }, 400);
        const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
        const subKey = "sub:" + await sha256hex(sub.endpoint);
        // preferenza "anche allerta gialla": se la richiesta non la indica (es. pagina admin) si mantiene quella salvata
        const prima = (await env.KV.getWithMetadata(subKey)).metadata || {};
        const gialla = typeof sub.gialla === "boolean" ? sub.gialla : prima.g === 1;
        if (gialla) clean.g = 1;
        if (prima.a === 1) clean.a = 1; // amministratore che riceve gli avvisi di malfunzionamento
        if (prima.m) clean.m = prima.m; // telefono con l'area soci attiva
        if (prima.endpoint && JSON.stringify(prima) === JSON.stringify(clean)) return json({ ok: true }); // niente di nuovo: non salvo
        // al massimo 20 iscrizioni nuove all'ora dallo stesso indirizzo (protezione contro iscrizioni false in massa)
        if (!prima.endpoint && await contatore("sub:" + ipOf(req), 3600, true) > 20) return json({ error: "troppe iscrizioni da questa rete, riprova più tardi" }, 429);
        if (JSON.stringify(clean).length > 1000) return json({ error: "iscrizione troppo grande" }, 400);
        await env.KV.put(subKey, "1", { metadata: clean });
        return json({ ok: true });
      }
      if (url.pathname === "/unsubscribe" && req.method === "POST") {
        const { endpoint } = (await req.json().catch(() => null)) || {};
        const k = typeof endpoint === "string" ? "sub:" + await sha256hex(endpoint) : null;
        if (k && (await env.KV.getWithMetadata(k)).metadata) await env.KV.delete(k); // cancello solo se esiste
        return json({ ok: true });
      }

      if (url.pathname === "/avvisi") {
        // il nome di chi ha pubblicato lo vedono solo gli amministratori
        const list = await getAvvisi(env);
        const u = req.headers.get("Authorization") ? await auth(req, env) : null;
        return json(u && !u.blocked ? list : list.filter(visibile).map(({ autore, modificatoDa, notifica, ...a }) => a));
      }
      if (url.pathname === "/dae") { const d = await env.KV.get("dae", "json"); return d ? json(d) : json({ error: "elenco non ancora disponibile" }, 404); }

      /* --- da qui in poi serve un codice valido --- */
      const ADMIN_PATHS = ["/login", "/avviso", "/avviso-elimina", "/stato", "/dae-aggiorna", "/lazio-aggiorna", "/sorveglianza", "/sorveglianza-prova", "/prova", "/prova-me", "/soci/invia", "/soci/attivazioni", "/soci/codici", "/soci/codice-crea", "/soci/codice-revoca", "/soci/regola", "/soci/approva", "/soci/scollega", "/codici", "/codice-crea", "/codice-revoca"];
      if (ADMIN_PATHS.includes(url.pathname)) {
        const u = await auth(req, env);
        if (!u || u.blocked) return denied(u);
        const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

        if (url.pathname === "/login") return json({ ok: true, nome: u.nome, ruolo: u.ruolo });

        if (url.pathname === "/avviso" && req.method === "POST") {
          // nuovo avviso, oppure modifica di uno esistente (body.id)
          const tipo = TIPI.includes(body.tipo) ? body.tipo : "avviso";
          const titolo = String(body.titolo || "").trim(), testo = String(body.testo || "").trim();
          if (!titolo || titolo.length > 90) return json({ error: "titolo obbligatorio (massimo 90 caratteri)" }, 400);
          if (testo.length > 600) return json({ error: "testo troppo lungo (massimo 600 caratteri)" }, 400);
          if (tipo === "evento" && !isoDay(body.data)) return json({ error: "per un evento serve la data" }, 400);
          if (body.fino && !isoDay(body.fino)) return json({ error: "data di scadenza non valida" }, 400);
          if (body.fino && body.fino < romeIso()) return json({ error: "la data \"mostra fino al\" è già passata" }, 400);
          let quando = null;
          if (body.quando) {
            const t = Date.parse(body.quando);
            if (!isFinite(t)) return json({ error: "data di pubblicazione non valida" }, 400);
            if (t > Date.now() + 60e3) { if (t > Date.now() + 60 * 86400e3) return json({ error: "si può programmare al massimo 60 giorni avanti" }, 400); quando = new Date(t).toISOString(); }
          }
          const list = await getAvvisi(env), now = new Date().toISOString();
          const prima = body.id ? list.find((a) => a.id === body.id) : null;
          if (body.id && !prima) return json({ error: "avviso non trovato (forse è stato tolto)" }, 404);
          const avviso = {
            id: prima ? prima.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6), tipo, titolo, testo,
            data: prima && !prima.programmato ? prima.data : (quando || now), autore: prima ? prima.autore : u.nome,
            ...(tipo === "evento" ? { giorno: body.data, ora: String(body.ora || "").slice(0, 30), luogo: String(body.luogo || "").slice(0, 80) } : {}),
            ...(body.fino && tipo !== "evento" ? { fino: body.fino } : {}),
            ...(prima ? { modificato: now, modificatoDa: u.nome } : {}),
          };
          const programmato = !!quando && (!prima || !!prima.programmato);
          if (programmato) { avviso.programmato = true; avviso.notifica = body.notifica !== false; }
          const nuova = prima ? list.map((a) => (a.id === avviso.id ? avviso : a)) : [avviso, ...list].slice(0, 30);
          await env.KV.put("avvisi", JSON.stringify(nuova));
          let esito = null;
          if (!programmato && body.notifica !== false && (!prima || prima.programmato || body.notifica === true)) esito = await notificaAvviso(env, avviso);
          return json({ ok: true, avviso, esito });
        }
        if (url.pathname === "/avviso-elimina" && req.method === "POST") {
          await env.KV.put("avvisi", JSON.stringify((await getAvvisi(env)).filter((a) => a.id !== body.id)));
          return json({ ok: true });
        }
        if (url.pathname === "/stato") {
          let n = 0, cursor;
          do { const p = await env.KV.list({ prefix: "sub:", cursor }); n += p.keys.length; cursor = p.list_complete ? null : p.cursor; } while (cursor);
          const dae = await env.KV.get("dae", "json");
          return json({ iscritti: n, storico: ((await env.KV.get("iscritti-storico", "json")) || []).slice(-60), ultimoInvio: await env.KV.get("ultimo-invio", "json"), ultimoBollettino: await env.KV.get("ultimo-bollettino"),
            dae: { aggiornato: dae?.aggiornato || null, n: dae?.dae?.length || 0 },
            salute: await salute(env, n) });
        }
        if (url.pathname === "/dae-aggiorna" && req.method === "POST") {
          const d = await checkDae(env);
          await patchSalute(env, "dae", d.ok ? "ok" : "ko", d.ok ? d.n + " DAE · letta " + hm(new Date().toISOString()) : "errore", d.ok ? "" : d.errore + ". L'app mostra l'ultimo elenco valido.");
          return json(d);
        }
        if (url.pathname === "/lazio-aggiorna" && req.method === "POST") {
          const es = await checkLazio(env, true), ko = es.filter((x) => !x.ok);
          await patchSalute(env, "regione", ko.length ? "ko" : "ok", ko.length ? "errore" : "letta " + hm(new Date().toISOString()), ko.map((x) => x.errore).join("; "));
          return json(es);
        }
        if (url.pathname === "/sorveglianza-prova" && req.method === "POST") {
          // prova dell'avviso di malfunzionamento: arriva solo ai telefoni con la spunta "Avvisami"
          const r = await broadcast(env, { title: "🛠️ Prova avviso di malfunzionamento", body: "Se leggi questo messaggio, gli avvisi di malfunzionamento di Cave Informa arrivano su questo telefono.", url: "./admin.html", tag: "sorveglianza-prova" }, "normal", (sub) => sub.a === 1, true);
          return json(r);
        }
        if (url.pathname === "/sorveglianza" && req.method === "POST") {
          // attiva/disattiva gli avvisi di malfunzionamento per il telefono che fa la richiesta
          if (!body.endpoint) return json({ error: "manca l'iscrizione del telefono" }, 400);
          const k = "sub:" + await sha256hex(body.endpoint), cur = await env.KV.getWithMetadata(k);
          if (!cur.metadata) return json({ error: "questo telefono non risulta iscritto alle notifiche" }, 404);
          if (typeof body.on !== "boolean") return json({ on: cur.metadata.a === 1 });
          const md = { ...cur.metadata }; if (body.on) md.a = 1; else delete md.a;
          if (body.on !== (cur.metadata.a === 1)) await env.KV.put(k, "1", { metadata: md });
          return json({ on: body.on });
        }
        if (url.pathname === "/prova" && req.method === "POST") {
          return json(await broadcast(env, { title: "Notifica di prova", body: "Se leggi questo messaggio, le notifiche di Cave Informa funzionano.", url: "./", tag: "prova" }, "normal"));
        }
        if (url.pathname === "/prova-me" && req.method === "POST") {
          // notifica di prova solo al telefono che la chiede (deve essere iscritto)
          const k = await env.KV.getWithMetadata("sub:" + await sha256hex(String(body.endpoint || "")));
          if (!k || !k.metadata) return json({ error: "questo telefono non risulta iscritto alle notifiche" }, 404);
          const st = await sendOne(env, await vapidKeys(env), k.metadata, { title: "Notifica di prova", body: "Ciao " + u.nome + ", le notifiche di Cave Informa funzionano su questo telefono.", url: "./admin.html", tag: "prova-me" }, "normal");
          return st >= 200 && st < 300 ? json({ ok: true }) : json({ error: "il servizio di notifiche ha risposto " + st }, 502);
        }
        if (url.pathname === "/soci/invia" && req.method === "POST") {
          // attivazione / messaggio ai soci: notifica solo ai telefoni con l'area soci attiva
          const titolo = String(body.titolo || "").trim(), testo = String(body.testo || "").trim();
          if (!titolo || titolo.length > 90) return json({ error: "titolo obbligatorio (massimo 90 caratteri)" }, 400);
          if (testo.length > 600) return json({ error: "testo troppo lungo (massimo 600 caratteri)" }, 400);
          const ids = new Set((await getSoci(env)).map((x) => x.id));
          if (!ids.size) return json({ error: "non ci sono ancora soci: crea i codici nella scheda Persone" }, 400);
          const m = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), titolo, testo, data: new Date().toISOString(), autore: u.nome, conferma: body.conferma !== false };
          const r = await broadcast(env, { title: titolo, body: testo.slice(0, 180) + (m.conferma ? (testo ? " · " : "") + "Tocca per rispondere" : ""), url: "./#soci-" + m.id, tag: "soci-" + m.id }, "high", (sub) => ids.has(sub.m), true);
          m.inviati = r.sent;
          await env.KV.put("soci-msg", JSON.stringify([m, ...(await getSociMsg(env))].slice(0, 20)));
          return json({ ok: true, messaggio: m, esito: r });
        }
        if (url.pathname === "/soci/attivazioni") {
          const soci = await getSoci(env), msgs = (await getSociMsg(env)).slice(0, 5), disp = await dispositiviSoci(env);
          const out = await Promise.all(msgs.map(async (m) => ({ ...m, risposte: m.conferma ? await rispostePer(env, m.id) : [] })));
          return json({ dispositivi: disp, soci: soci.map((x) => ({ id: x.id, nome: x.nome })), messaggi: out });
        }
        /* gestione delle persone: solo l'amministratore principale */
        if (u.ruolo !== "principale") return json({ error: "solo l'amministratore principale può gestire le persone" }, 403);
        if (url.pathname === "/codici") return json((await getCodici(env)).map(({ hash, ...c }) => c));
        if (url.pathname.startsWith("/soci/codic") && u.ruolo !== "principale") return json({ error: "solo l'amministratore principale può gestire i soci" }, 403);
        if (url.pathname === "/soci/codici") {
          const disp = new Map(); let cursor;
          do { const p = await env.KV.list({ prefix: "sub:", cursor }); cursor = p.list_complete ? null : p.cursor; for (const k of p.keys) if (k.metadata && k.metadata.m) disp.set(k.metadata.m, (disp.get(k.metadata.m) || 0) + 1); } while (cursor);
          return json((await getSoci(env)).map(({ hash, tel, attesa, ...x }) => ({ ...x, telefoni: disp.get(x.id) || 0, attivoDal: tel ? tel.at : null, attesaDal: attesa ? attesa.at : null })));
        }
        if (url.pathname === "/soci/regola") {
          if (req.method === "POST") { if (!["approva", "sostituisci", "blocca"].includes(body.regola)) return json({ error: "regola non valida" }, 400); await env.KV.put("soci-regola", body.regola); }
          return json({ regola: await getRegola(env) });
        }
        if (url.pathname === "/soci/approva" && req.method === "POST") {
          const list = await getSoci(env), x = list.find((y) => y.id === body.id);
          if (!x || !x.attesa) return json({ error: "nessuna richiesta in attesa per questo socio" }, 404);
          if (body.ok) await collega(env, x, x.attesa.t, x.attesa.e);
          else { await env.KV.delete("socio-tok:" + x.attesa.t); delete x.attesa; }
          await env.KV.put("soci", JSON.stringify(list));
          return json({ ok: true });
        }
        if (url.pathname === "/soci/scollega" && req.method === "POST") {
          const list = await getSoci(env), x = list.find((y) => y.id === body.id);
          if (!x) return json({ error: "socio non trovato" }, 404);
          await scollega(env, x); await env.KV.put("soci", JSON.stringify(list));
          return json({ ok: true });
        }
        if (url.pathname === "/soci/codice-crea" && req.method === "POST") {
          const nome = String(body.nome || "").trim().slice(0, 60);
          if (!nome) return json({ error: "scrivi il nome del socio" }, 400);
          const list = await getSoci(env);
          if (list.length >= 300) return json({ error: "troppi soci: revocane qualcuno" }, 400);
          const codice = nuovoCodice();
          list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), nome, hash: await sha256hex("socio:" + normCod(codice)), creato: new Date().toISOString() });
          await env.KV.put("soci", JSON.stringify(list));
          return json({ nome, codice });
        }
        if (url.pathname === "/soci/codice-revoca" && req.method === "POST") {
          const list = await getSoci(env), x = list.find((y) => y.id === body.id);
          if (x) { await scollega(env, x); if (x.attesa) await env.KV.delete("socio-tok:" + x.attesa.t); }
          await env.KV.put("soci", JSON.stringify(list.filter((y) => y.id !== body.id)));
          return json({ ok: true });
        }
        if (url.pathname === "/codice-crea" && req.method === "POST") {
          const nome = String(body.nome || "").trim().slice(0, 60);
          if (!nome) return json({ error: "scrivi il nome della persona" }, 400);
          const list = await getCodici(env);
          if (list.length >= 30) return json({ error: "troppi codici: revocane qualcuno" }, 400);
          const codice = nuovoCodice();
          list.push({ id: Date.now().toString(36), nome, creato: new Date().toISOString(), ultimoUso: null, hash: await sha256hex("codice:" + codice.replace(/-/g, "")) });
          await env.KV.put("codici", JSON.stringify(list));
          return json({ ok: true, nome, codice });
        }
        if (url.pathname === "/codice-revoca" && req.method === "POST") {
          await env.KV.put("codici", JSON.stringify((await getCodici(env)).filter((c) => c.id !== body.id)));
          return json({ ok: true });
        }
        return json({ error: "non trovato" }, 404);
      }
      if (url.pathname === "/" || url.pathname === "/admin") return new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      return json({ error: "non trovato" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env).catch((e) => console.log("controlli", e)));
  },
};

/* ---------------- pagina /admin ---------------- */
const ADMIN_HTML = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cave Informa · Amministrazione</title>
<style>
:root{--bg:#EEF2F7;--card:#fff;--fg:#13202C;--muted:#5A6878;--line:#D3DAE2;--accent:#1D4F91;--ok:#2F7D4F;--err:#B42329;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0B1118;--card:#17212B;--fg:#E6ECF2;--muted:#9AA8B6;--line:#2A3846;--accent:#7FB0F0;--ok:#5CC08A;--err:#F06A6F;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:20px max(16px,env(safe-area-inset-left))}
h1{font-size:1.6rem;margin:0 0 4px}p{margin:0}.muted{color:var(--muted);font-size:.9rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:16px;display:grid;gap:10px}
label{font-weight:600;font-size:.9rem}input,textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
textarea{min-height:120px;resize:vertical}button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:10px 18px;background:var(--accent);color:#fff;cursor:pointer}
button.sec{background:transparent;color:var(--accent);border:1px solid var(--line)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.msg{font-size:.9rem}.ok{color:var(--ok)}.err{color:var(--err)}.av{border-top:1px solid var(--line);padding-top:10px;display:grid;gap:4px}
</style></head><body><main>
<h1>Cave Informa · Amministrazione</h1><p class="muted">Pagina riservata ai volontari: pubblica un avviso nell'app e invialo come notifica.</p>
<div class="card"><label for="tok">Password</label><input id="tok" type="password" autocomplete="current-password">
<div class="row"><button class="sec" id="stato" type="button">Mostra stato</button><button class="sec" id="prova" type="button">Invia notifica di prova</button><button class="sec" id="daeup" type="button">Aggiorna DAE ora</button></div><p class="msg" id="info"></p></div>
<form class="card" id="f"><label for="t">Titolo</label><input id="t" maxlength="80" required placeholder="Es. Strada provinciale chiusa">
<label for="x">Testo</label><textarea id="x" maxlength="600" required placeholder="Cosa succede, dove, fino a quando, cosa fare."></textarea>
<label class="row" style="font-weight:400"><input id="n" type="checkbox" checked style="width:auto"> Invia anche come notifica</label>
<button type="submit">Pubblica avviso</button><p class="msg" id="esito"></p></form>
<div class="card"><strong>Avvisi pubblicati</strong><div id="lista" class="muted">Caricamento…</div></div>
</main><script>
const $=s=>document.querySelector(s);try{$("#tok").value=localStorage.getItem("tok")||""}catch(e){}
const H=()=>{try{localStorage.setItem("tok",$("#tok").value)}catch(e){};return{"Content-Type":"application/json","Authorization":"Bearer "+$("#tok").value}};
const show=(el,t,ok)=>{el.textContent=t;el.className="msg "+(ok?"ok":"err")};
async function lista(){const l=await (await fetch("/avvisi")).json();$("#lista").innerHTML=l.length?"":"Nessun avviso.";
for(const a of l){const d=document.createElement("div");d.className="av";d.innerHTML="<strong></strong><span></span><small class='muted'></small><div><button class='sec' type='button'>Elimina</button></div>";
d.querySelector("strong").textContent=a.titolo;d.querySelector("span").textContent=a.testo;d.querySelector("small").textContent=new Date(a.data).toLocaleString("it-IT");
d.querySelector("button").onclick=async()=>{const r=await fetch("/avviso-elimina",{method:"POST",headers:H(),body:JSON.stringify({id:a.id})});if(r.ok)lista();else show($("#info"),"Password errata",0)};$("#lista").append(d)}}
$("#stato").onclick=async()=>{const r=await fetch("/stato",{headers:H()});const j=await r.json();if(!r.ok)return show($("#info"),j.error,0);
const dc=j.dae&&j.dae.controllo;
show($("#info"),"Telefoni iscritti: "+j.iscritti+(j.ultimoInvio?" · Ultimo invio: "+new Date(j.ultimoInvio.at).toLocaleString("it-IT")+" ("+j.ultimoInvio.sent+" consegnate)":"")+(j.ultimoBollettino?" · Ultimo bollettino letto: "+j.ultimoBollettino:"")
 +" · DAE: "+(j.dae&&j.dae.n?j.dae.n+" in elenco, cambiato il "+new Date(j.dae.aggiornato).toLocaleString("it-IT"):"elenco non ancora letto")+(dc?(dc.ok?" (ultimo controllo "+new Date(dc.at).toLocaleTimeString("it-IT")+")":" — ERRORE: "+dc.errore):""),!dc||dc.ok)};
$("#daeup").onclick=async()=>{const r=await fetch("/dae-aggiorna",{method:"POST",headers:H()});const j=await r.json();if(!r.ok)return show($("#info"),j.error,0);j.ok?show($("#info"),"Mappa DAE letta: "+j.n+" defibrillatori",1):show($("#info"),"DAE: "+j.errore,0)};
$("#prova").onclick=async()=>{const r=await fetch("/prova",{method:"POST",headers:H()});const j=await r.json();r.ok?show($("#info"),"Notifica di prova inviata a "+j.sent+" telefoni",1):show($("#info"),j.error,0)};
$("#f").onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;
const r=await fetch("/avviso",{method:"POST",headers:H(),body:JSON.stringify({titolo:$("#t").value.trim(),testo:$("#x").value.trim(),notifica:$("#n").checked})});const j=await r.json();b.disabled=false;
if(!r.ok)return show($("#esito"),j.error,0);show($("#esito"),"Avviso pubblicato"+(j.esito?" e inviato a "+j.esito.sent+" telefoni":""),1);$("#t").value="";$("#x").value="";lista()};
lista();
</script></body></html>`;
