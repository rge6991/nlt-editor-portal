// NLT editor portal backend.
// The browser never sees an Airtable key: every read and write goes through here.
// Login: email -> 6-digit code by email -> session token (30 days). Unknown emails get the same answer
// as known ones; codes, guesses and requests per IP are capped in Postgres (rate_hit, issue_login_code,
// try_login_code), so parallel requests can't get past the limits. Inactive editors can't log in.
// Each editor only ever gets their own videos and payouts, and never any bank or payment-method fields.
// Reviewers (Reviewers table, Active ticked) get the review queue and can approve or request changes.
// Caption check: spelling and NLT tone notes from Claude. Suggestions only; it never writes a caption.
// Templates: editors see the Active rows of the Templates table and pick one when they submit.
// Payouts: every second Friday the Airtable "Pay run" automation creates one Payouts row per editor
// (USD total, USD→PHP rate, pesos sent). Editors see them on the Payments page.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import nodemailer from "npm:nodemailer@6.9.16";

const AIRTABLE = "https://api.airtable.com/v0/app9LXJtFUqO3VN0V";
const T_EDITORS = "tbla4YKeVLmMN8Ay6";
const T_VIDEOS = "tblZm9wz5Truwc9au";
const T_REVIEWERS = "tblqHqYCyBNKqq88k";
const T_PAYOUTS = "tblU046MpsrNhN1Sd";
// Caption Examples: rows with "Use in checker" ticked are the examples the caption check judges against.
const T_CAPTIONS = "tbllar9yr94bmdzi4";
const CX = { caption: "fldNGy7VRCQ1XFR6M", why: "fldN5j0BDHvDxiWTW", use: "fldGm9qF4fxHHgapU" };
// Templates: Active rows show up in the portal and can be picked when submitting.
// While "Live for editors" is unticked, only the team (anyone in Reviewers) sees a template, for testing.
// A video made with a template pays the template's Pay once approved (Payout formula in Airtable);
// since only the team can pick a template before it's live, real editors' pay is unchanged until then.
// The internal Best Practices link is never read here.
const T_TEMPLATES = "tblgOYxWHFZ4peswS";
const TP = {
  name: "fldkzD6rI2M5xBFCt",
  level: "fld1HGnsTF9lzapMy",
  pay: "fldqdIvNapqByt6bo",
  needed: "fldsaneZRYbFT9CyS",
  open: "fldRndMphlqLzqaa7",
  example: "fldjNxAFSescaDwbc",
  brief: "fldBTGYMukYotyruJ",
  text: "fld8tcWoJB4QSbwMu",
  caption: "fldlx6p6Oe9H8iBk8",
  music: "fldduTsffgEdHDsSk",
  active: "fldzWMkpVMi2E94hD",
  live: "fldX9foaMixWqRG83",
  sound: "fldRWRjmfDBVrZhJF",
  made: "fldCQhsg6K5Ml80l4",
};
// Paydays are every second Friday from this date. Keep in step with PAY_ANCHOR in the Airtable "Pay run" script.
const PAY_ANCHOR = "2026-10-23";

// Airtable field IDs (stable even if a field is renamed).
const E = {
  name: "fldFLDtCBfmeenmbA",
  email: "fldB6DAOCuMorquqi",
  status: "fldq9ZDw3Aisnrk41",
  rate: "fldBraYbnmNkX6dGm",
  payModel: "fldHvik5ne9dCqDuH",
  videos: "fld1fG1EktpR6rVz3",
  payouts: "fldSlw6Wevg9MMmYx",
};
// Payouts table. Only these fields ever leave Airtable (no bank details live here anyway).
const P = {
  payDate: "fld9c9NgdPutRxxxk",
  status: "fldzl4D2Ju0heP3U6",
  videos: "fld12Eq93AhPt1qet",
  usd: "fldj7jQ7r0j5g0FdH",
  rate: "fld6SRXDn6Sk1C8g2",
  rateSource: "fldPce5AKeGFQaqx6",
  php: "fldyF5aAJNNmrpChs",
  paidTo: "fldL1lrgmJjN5WIuF",
  paidOn: "fldHKfgVv3HsXAtzC",
  receipt: "fldgbqJiCPwxcSFMQ",
  note: "fldVm3tU1Kv2GHef5",
};
const V = {
  title: "fldEyhvtnSXTmjedf",
  editor: "fldoGXAz7bI1yLA5p",
  caption: "fldCSzZHKeNceKLDk",
  status: "fldOWa9EJROGNrkMU",
  notes: "fldZn9Uq448vcVbee",
  submitted: "fldaq3aKH94DdqNYi",
  reviewed: "fld1nUGT13osCx3az",
  payout: "fldjVEOI3FlORyNxZ",
  link: "fldzBMnMv3QvvxCrd",
  paid: "fldpQTDx8urFy5EJ1",
  music: "fldQucuoYYNVYRR8X",
  publishAt: "fldWF7Wc4dwMa8333",
  posted: "fldNaAVRjB5BfCR23",
  reviewedBy: "fldeWUK7NvZf4WPgh",
  history: "fldlI5mW1Hv3SHPDb",
  template: "fldnRWL6CYJ29T1kD",
};
const R = {
  name: "fldgefYb3VGVGtecX",
  email: "fldIXnAPbLeygkjBu",
  active: "fldlqaBZhYqwFk9U7",
};
const MUSIC_URL = /^https?:\/\/\S+\.\S+/i;

const CLAUDE_MODEL = "claude-haiku-5-5";
const CHECKS_PER_HOUR = 30;
const VOICE_RULES = `You check social media captions for No Limits Tour (NLT), the professional cliff diving world tour. A video editor wrote the caption below. Point out spelling, grammar and punctuation mistakes, and say briefly where the caption drifts from NLT's voice.

Never write a new caption and never rewrite whole sentences. The caption stays the editor's own work; you only point things out.

NLT's voice for captions:
- Short and punchy: one or two short lines. Let the dive speak.
- A short tease that the video then pays off works well, for example "Maybe the perfect shot does exist…".
- When the video is about one athlete, name them or @tag them. Saying where or at which event (for example Area 47) helps people find the post.
- Direct, confident and warm. Playful humor is welcome.
- A question to the viewer is optional. If there is one, it should be specific and easy to answer: a number, or a pick between two things. Point out generic questions such as "Would you jump?"; on NLT's posts they got no answers.
- One or two emoji at the end of a line, not more.
- American English spelling (color, favorite, center).
- No em dashes.
- No generic sport-marketing words such as unleash, ignite, elevate or epic journey, and no lines that would fit any sports video, such as "hard work paid off".
- Hashtags are optional: at most five, all at the very end (Instagram allows five).
- Cliff diving is a professional sport: never call it a stunt, a show or a trick.`;
const VOICE_ANSWER = `How to answer:
- spelling: only real mistakes. "wrong" is copied exactly from the caption, a few words long, and "right" is the corrected version of that same snippet. Leave names, emoji, hashtags, deliberate slang and style choices alone.
- tone: at most three notes, one short sentence each, in plain English. Each note names the part of the caption it is about and says what to change. Leave it empty when the caption fits the voice.
- verdict: "ready" when nothing important needs changing, "small fixes" for spelling or small tone points, "needs work" when the caption clearly misses the voice or is hard to understand.`;
const CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ready", "small fixes", "needs work"] },
    spelling: {
      type: "array",
      items: {
        type: "object",
        properties: { wrong: { type: "string" }, right: { type: "string" } },
        required: ["wrong", "right"],
        additionalProperties: false,
      },
    },
    tone: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "spelling", "tone"],
  additionalProperties: false,
};

const ALLOWED_ORIGINS = new Set([
  "https://editors.the-nlt.com",
  "https://jobs.the-nlt.com",
  ...(Deno.env.get("EXTRA_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);
const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

const CODE_TTL_MIN = 10;
const SESSION_DAYS = 30;
// Uploads go straight from the browser to Cloudinary, signed here (CLOUDINARY_API_KEY / _SECRET secrets).
const CLOUD_NAME = "os1vbtid";
const VIDEO_FORMATS = "mp4,mov,m4v,webm,avi";
const UPLOADS_PER_HOUR = 30;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// ---------- helpers ----------

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function cors(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://editors.the-nlt.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normaliseEmail(raw: unknown): string {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address.");
  return email;
}

function viennaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna" }).format(new Date());
}

function clip(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

// A video in NLT's own Cloudinary account, or "". Parsed as a URL, so "../" tricks can't point elsewhere.
function ourVideo(raw: unknown): string {
  try {
    const u = new URL(clip(raw, 1000));
    if (u.protocol !== "https:" || u.hostname !== "res.cloudinary.com" || u.port || u.username || u.password) return "";
    return u.pathname.startsWith("/os1vbtid/video/upload/") ? u.href : "";
  } catch {
    return "";
  }
}

// Links we hand to the browser: only http(s), never javascript: or data:.
function webLink(v: unknown): string {
  const s = String(v ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

// The caller's IP as Supabase passes it on. Only used as a rate-limit key.
function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64) || "unknown";
}

// Counts one request against a limit in Postgres; false once the limit is reached.
async function allow(key: string, window: string, max: number): Promise<boolean> {
  const { data, error } = await db.rpc("rate_hit", { p_key: key, p_window: window, p_max: max });
  if (error) {
    console.error("rate_hit", error);
    throw new HttpError(500, "Something went wrong. Try again.");
  }
  return data === true;
}

const pause = () => new Promise((r) => setTimeout(r, 700 + Math.random() * 900));

async function airtable(path: string, init: RequestInit = {}) {
  const token = Deno.env.get("AIRTABLE_PORTAL_TOKEN");
  if (!token) throw new HttpError(503, "The portal isn't connected to Airtable yet.");
  const res = await fetch(`${AIRTABLE}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    console.error("airtable", res.status, await res.text());
    throw new HttpError(502, "Couldn't reach Airtable. Try again in a minute.");
  }
  return res.json();
}

function payoutNumber(v: unknown): number {
  const raw = Array.isArray(v) ? v[0] : v;
  const n = parseFloat(String(raw ?? ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function selectName(v: unknown): string {
  if (v && typeof v === "object" && "name" in (v as Record<string, unknown>)) return String((v as { name: string }).name);
  return typeof v === "string" ? v : "";
}

// ---------- who can log in ----------

// Editors and active reviewers by email, cached for a minute, so login requests (including ones for
// unknown emails) don't each cost Airtable calls.
type Person = { id: string; name: string; active: boolean };
let dirCache: { at: number; editors: Map<string, Person>; reviewers: Map<string, Person> } | null = null;

async function directory() {
  if (dirCache && Date.now() - dirCache.at < 60_000) return dirCache;
  const editors = new Map<string, Person>();
  const reviewers = new Map<string, Person>();
  let offset = "";
  do {
    const fields = [E.name, E.email, E.status].map((f) => `fields[]=${f}`).join("&");
    const data = await airtable(`${T_EDITORS}?${fields}&returnFieldsByFieldId=true&pageSize=100${offset ? `&offset=${offset}` : ""}`);
    for (const r of data.records ?? []) {
      const email = String(r.fields?.[E.email] ?? "").trim().toLowerCase();
      const p = { id: r.id as string, name: String(r.fields?.[E.name] ?? ""), active: selectName(r.fields?.[E.status]) === "Active" };
      // If two rows share an email, the active one wins.
      if (email && (!editors.has(email) || (p.active && !editors.get(email)!.active))) editors.set(email, p);
    }
    offset = data.offset ?? "";
  } while (offset);
  offset = "";
  do {
    const fields = [R.name, R.email, R.active].map((f) => `fields[]=${f}`).join("&");
    const data = await airtable(`${T_REVIEWERS}?${fields}&returnFieldsByFieldId=true&pageSize=100${offset ? `&offset=${offset}` : ""}`);
    for (const r of data.records ?? []) {
      const email = String(r.fields?.[R.email] ?? "").trim().toLowerCase();
      if (email && r.fields?.[R.active] === true) reviewers.set(email, { id: r.id as string, name: String(r.fields?.[R.name] ?? ""), active: true });
    }
    offset = data.offset ?? "";
  } while (offset);
  dirCache = { at: Date.now(), editors, reviewers };
  return dirCache;
}

// What an email can log in as. Inactive editors can't log in as editors, except team members
// (anyone in Reviewers), so their test logins keep working.
async function rolesFor(email: string) {
  const d = await directory();
  const reviewer = d.reviewers.get(email) ?? null;
  const ed = d.editors.get(email) ?? null;
  return { editor: ed && (ed.active || reviewer) ? ed : null, reviewer };
}

// ---------- editors ----------

async function getEditor(id: string) {
  const fields = [E.name, E.email, E.status, E.rate, E.payModel, E.videos, E.payouts].map((f) => `fields[]=${f}`).join("&");
  // Single-record GET doesn't take fields[]; use a filtered list instead so bank fields never leave Airtable.
  const formula = encodeURIComponent(`RECORD_ID()="${id}"`);
  const data = await airtable(`${T_EDITORS}?filterByFormula=${formula}&${fields}&returnFieldsByFieldId=true&maxRecords=1`);
  const rec = data.records?.[0];
  if (!rec) throw new HttpError(401, "Your session has ended. Log in again.");
  return rec;
}

async function getVideos(ids: string[]) {
  const out: Record<string, unknown>[] = [];
  const fields = Object.values(V).map((f) => `fields[]=${f}`).join("&");
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const formula = encodeURIComponent(`OR(${chunk.map((id) => `RECORD_ID()="${id}"`).join(",")})`);
    let offset = "";
    do {
      const data = await airtable(`${T_VIDEOS}?filterByFormula=${formula}&${fields}&returnFieldsByFieldId=true&pageSize=100${offset ? `&offset=${offset}` : ""}`);
      out.push(...(data.records ?? []));
      offset = data.offset ?? "";
    } while (offset);
  }
  return out;
}

// ---------- payouts ----------

async function getPayouts(ids: string[]) {
  const out: { id: string; fields: Record<string, unknown> }[] = [];
  const fields = Object.values(P).map((f) => `fields[]=${f}`).join("&");
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const formula = encodeURIComponent(`OR(${chunk.map((id) => `RECORD_ID()="${id}"`).join(",")})`);
    let offset = "";
    do {
      const data = await airtable(`${T_PAYOUTS}?filterByFormula=${formula}&${fields}&returnFieldsByFieldId=true&pageSize=100${offset ? `&offset=${offset}` : ""}`);
      out.push(...(data.records ?? []));
      offset = data.offset ?? "";
    } while (offset);
  }
  return out;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function shapePayout(rec: { id: string; fields: Record<string, unknown> }) {
  const f = rec.fields;
  const receipts = ((f[P.receipt] as { url?: string; filename?: string }[] | undefined) ?? [])
    .filter((a) => /^https:\/\//.test(String(a.url ?? "")))
    .map((a) => ({ url: String(a.url), name: String(a.filename ?? "Receipt") }));
  return {
    id: rec.id,
    payDate: String(f[P.payDate] ?? ""),
    status: selectName(f[P.status]) || "To pay",
    paidOn: String(f[P.paidOn] ?? ""),
    usd: num(f[P.usd]) ?? 0,
    rate: num(f[P.rate]),
    php: num(f[P.php]),
    rateSource: String(f[P.rateSource] ?? ""),
    paidTo: String(f[P.paidTo] ?? ""),
    note: String(f[P.note] ?? ""),
    receipts,
    videoIds: (f[P.videos] as string[] | undefined) ?? [],
  };
}

// The next payday on or after today (Vienna), counting every 14 days from PAY_ANCHOR.
function nextPayday(): string {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
  const since = day(viennaToday()) - day(PAY_ANCHOR);
  const add = since <= 0 ? 0 : Math.ceil(since / 14) * 14;
  return new Date((day(PAY_ANCHOR) + add) * 86400000).toISOString().slice(0, 10);
}

// ---------- templates ----------

function shapeTemplate(rec: { id: string; fields: Record<string, unknown> }) {
  const f = rec.fields;
  const example = String(f[TP.example] ?? "");
  const open = num(f[TP.open]);
  return {
    id: rec.id,
    name: String(f[TP.name] ?? "").trim() || "Template",
    level: selectName(f[TP.level]),
    pay: num(f[TP.pay]),
    needed: num(f[TP.needed]),
    open,
    full: open !== null && open <= 0,
    example: /^https:\/\//.test(example) ? example : "",
    brief: String(f[TP.brief] ?? ""),
    textOnScreen: String(f[TP.text] ?? ""),
    caption: String(f[TP.caption] ?? ""),
    music: String(f[TP.music] ?? ""),
    active: f[TP.active] === true,
    live: f[TP.live] === true,
    sound: String(f[TP.sound] ?? ""),
    made: num(f[TP.made]) ?? 0,
  };
}
type Template = ReturnType<typeof shapeTemplate>;

// Who can see and pick a template: everyone once it's live, only the team before that.
const visibleTo = (t: Template, team: boolean) => t.active && (t.live || team);

// Every template, active or not, so older videos still show their template's name.
async function getTemplates(): Promise<Template[]> {
  const out: Template[] = [];
  const fields = Object.values(TP).map((f) => `fields[]=${f}`).join("&");
  let offset = "";
  do {
    const data = await airtable(`${T_TEMPLATES}?${fields}&returnFieldsByFieldId=true&pageSize=100${offset ? `&offset=${offset}` : ""}`);
    for (const r of data.records ?? []) out.push(shapeTemplate(r));
    offset = data.offset ?? "";
  } while (offset);
  // Simple before Medium before Advanced, open before full.
  const rank = (t: Template) => (t.full ? 3 : 0) + (t.level === "Advanced" ? 2 : t.level === "Medium" ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// What editors see of a template.
function editorTemplate(t: Template) {
  const { active: _active, ...rest } = t;
  return rest;
}

// "" or "own" means the editor's own idea. Anything else must be a template this person can see that isn't full.
async function pickTemplate(raw: unknown, s: { reviewerId: string | null }): Promise<string | null> {
  const id = clip(raw, 20);
  if (!id || id === "own") return null;
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new HttpError(400, "Pick a template from the list.");
  const t = (await getTemplates()).find((x) => x.id === id);
  const team = !!(t && t.active && !t.live && s.reviewerId && await activeReviewer(s.reviewerId));
  if (!t || !visibleTo(t, team)) throw new HttpError(400, "That template isn't available any more. Pick another one.");
  if (t.full) throw new HttpError(409, `We have enough "${t.name}" videos for now. Pick another template.`);
  return t.id;
}

function templateOf(f: Record<string, unknown>, templates: Map<string, Template>) {
  const id = ((f[V.template] as string[] | undefined) ?? [])[0];
  return id ? templates.get(id) ?? null : null;
}

// ---------- reviewers ----------

// Returns the reviewer if they are still Active, otherwise null.
async function activeReviewer(id: string) {
  const formula = encodeURIComponent(`RECORD_ID()="${id}"`);
  const fields = [R.name, R.active].map((f) => `fields[]=${f}`).join("&");
  const data = await airtable(`${T_REVIEWERS}?filterByFormula=${formula}&${fields}&returnFieldsByFieldId=true&maxRecords=1`);
  const rec = data.records?.[0];
  if (!rec || rec.fields?.[R.active] !== true) return null;
  return { id: rec.id as string, name: String(rec.fields?.[R.name] ?? "Reviewer") };
}

async function requireReviewer(s: { reviewerId: string | null }) {
  if (!s.reviewerId) throw new HttpError(403, "This account can't review videos.");
  const r = await activeReviewer(s.reviewerId);
  if (!r) throw new HttpError(403, "Your reviewer access has been switched off.");
  return r;
}

async function editorNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let offset = "";
  do {
    const data = await airtable(`${T_EDITORS}?fields[]=${E.name}&returnFieldsByFieldId=true&pageSize=100${offset ? `&offset=${offset}` : ""}`);
    for (const r of data.records ?? []) names.set(r.id, String(r.fields?.[E.name] ?? ""));
    offset = data.offset ?? "";
  } while (offset);
  return names;
}

function shapeVideo(rec: { id: string; fields: Record<string, unknown> }, templates: Map<string, Template> = new Map()) {
  const f = rec.fields;
  const link = String(f[V.link] ?? "");
  const t = templateOf(f, templates);
  return {
    template: t ? { id: t.id, name: t.name, pay: t.pay } : null,
    id: rec.id,
    title: String(f[V.title] ?? ""),
    status: selectName(f[V.status]) || "Submitted",
    submitted: String(f[V.submitted] ?? ""),
    reviewed: String(f[V.reviewed] ?? ""),
    videoUrl: /^https:\/\//.test(link) ? link : "",
    caption: String(f[V.caption] ?? ""),
    music: webLink(f[V.music]),
    feedback: String(f[V.notes] ?? ""),
    amount: payoutNumber(f[V.payout]),
    paid: f[V.paid] === true,
    publishAt: String(f[V.publishAt] ?? ""),
    posted: f[V.posted] === true,
  };
}

// ---------- sessions ----------

async function sessionFrom(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Log in to continue.");
  const { data, error } = await db.from("sessions").select("editor_id, reviewer_id, email, expires_at")
    .eq("token_hash", await sha256(token)).maybeSingle();
  if (error) throw new HttpError(500, "Something went wrong. Try again.");
  if (!data || new Date(data.expires_at) < new Date()) throw new HttpError(401, "Your session has ended. Log in again.");
  return {
    editorId: (data.editor_id as string | null) ?? null,
    reviewerId: (data.reviewer_id as string | null) ?? null,
    email: data.email as string,
    token,
  };
}

// ---------- email ----------

async function sendCodeEmail(to: string, name: string, code: string) {
  const user = Deno.env.get("MAIL_USER");
  const pass = Deno.env.get("MAIL_APP_PASSWORD");
  if (!user || !pass) throw new HttpError(503, "Login emails aren't set up yet.");
  const transport = nodemailer.createTransport({
    host: Deno.env.get("MAIL_HOST") ?? "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  const first = (name.split(" ")[0] || "there").replace(/[<>&"']/g, "");
  await transport.sendMail({
    from: `No Limits Tour <${user}>`,
    to,
    subject: `${code} is your NLT editor portal code`,
    text: `Hi ${first},\n\nYour code for the NLT editor portal is ${code}. It expires in ${CODE_TTL_MIN} minutes.\n\nIf you didn't ask for it, ignore this email.\n\nNo Limits Tour`,
    html: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;color:#00342B;line-height:1.5">
      <p>Hi ${first},</p>
      <p>Your code for the NLT editor portal:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0;color:#00342B">${code}</p>
      <p>It expires in ${CODE_TTL_MIN} minutes. If you didn't ask for it, ignore this email.</p>
      <p style="color:#6b7b77">No Limits Tour</p></div>`,
  });
}

// ---------- actions ----------

async function requestCode(req: Request, body: Record<string, unknown>) {
  const email = normaliseEmail(body.email);
  if (!await allow(`code-ip:${clientIp(req)}`, "1 hour", 20)) throw new HttpError(429, "Too many login attempts from here. Wait an hour, then try again.");

  const { editor, reviewer } = await rolesFor(email);
  // Same answer whether or not the email is on the list, so nobody can find out who works with NLT.
  if (!editor && !reviewer) {
    await pause();
    return { ok: true };
  }
  const person = editor?.name || reviewer?.name || "";

  // At most 5 codes an hour and 10 a day per email, counted atomically in Postgres.
  const code = randomCode();
  const expires = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000).toISOString();
  const { data: issued, error } = await db.rpc("issue_login_code", { p_email: email, p_hash: await sha256(`${email}:${code}`), p_expires: expires });
  if (error) throw new HttpError(500, "Something went wrong. Try again.");
  if (issued !== true) throw new HttpError(429, "Too many codes requested. Wait an hour, then try again.");
  try {
    await sendCodeEmail(email, person, code);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("mail", e);
    throw new HttpError(502, "Couldn't send the email. Try again in a minute.");
  }
  return { ok: true };
}

async function verifyCode(req: Request, body: Record<string, unknown>) {
  const email = normaliseEmail(body.email);
  const code = String(body.code ?? "").replace(/\D/g, "");
  if (code.length !== 6) throw new HttpError(400, "Enter the 6-digit code from the email.");
  if (!await allow(`verify-ip:${clientIp(req)}`, "1 hour", 30)) throw new HttpError(429, "Too many tries from here. Wait an hour, then try again.");

  // Counts the try before comparing, atomically: at most 5 tries per code, even in parallel.
  const { data: rows, error: tryError } = await db.rpc("try_login_code", { p_email: email });
  if (tryError) throw new HttpError(500, "Something went wrong. Try again.");
  const row = (rows as { code_id: number; code_hash: string }[] | null)?.[0];
  if (!row) throw new HttpError(400, "That code has expired or was tried too often. Ask for a new one.");
  if (row.code_hash !== await sha256(`${email}:${code}`)) throw new HttpError(400, "That code didn't work. Check the email and try again.");
  await db.from("login_codes").delete().eq("email", email);

  const { editor, reviewer } = await rolesFor(email);
  if (!editor && !reviewer) throw new HttpError(404, "That email isn't on the editor or reviewer list.");
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from("sessions").insert({
    token_hash: await sha256(token),
    editor_id: editor?.id ?? null,
    reviewer_id: reviewer?.id ?? null,
    email,
    expires_at: expires,
  });
  if (error) throw new HttpError(500, "Something went wrong. Try again.");
  return { token };
}

async function dashboard(req: Request) {
  const s = await sessionFrom(req);
  // Someone added to Reviewers after logging in gets review access without logging in again.
  if (!s.reviewerId) {
    const { reviewer: r } = await rolesFor(s.email);
    if (r) {
      s.reviewerId = r.id;
      await db.from("sessions").update({ reviewer_id: s.reviewerId }).eq("token_hash", await sha256(s.token));
    }
  }
  const [edRec, reviewer] = await Promise.all([
    s.editorId ? getEditor(s.editorId) : Promise.resolve(null),
    s.reviewerId ? activeReviewer(s.reviewerId) : Promise.resolve(null),
  ]);
  // An editor set to Inactive loses access straight away (team test logins excepted).
  const ed = edRec && (selectName(edRec.fields?.[E.status]) === "Active" || reviewer) ? edRec : null;
  if (!ed && !reviewer) throw new HttpError(401, "Your access to the portal has ended. Check with Raphael.");
  let editor = null;
  let videos: ReturnType<typeof shapeVideo>[] = [];
  let payouts: ReturnType<typeof shapePayout>[] = [];
  let templates: ReturnType<typeof editorTemplate>[] = [];
  if (ed) {
    const ids = (ed.fields?.[E.videos] as string[] | undefined) ?? [];
    const payoutIds = (ed.fields?.[E.payouts] as string[] | undefined) ?? [];
    // A payouts or templates hiccup must never stop editors from seeing and submitting videos.
    const [vrecs, precs, tlist] = await Promise.all([
      getVideos(ids),
      getPayouts(payoutIds).catch((e) => { console.error("payouts", e); return []; }),
      getTemplates().catch((e) => { console.error("templates", e); return [] as Template[]; }),
    ]);
    const tmap = new Map(tlist.map((t) => [t.id, t]));
    templates = tlist.filter((t) => visibleTo(t, !!reviewer)).map(editorTemplate);
    videos = vrecs.map((r) => shapeVideo(r as { id: string; fields: Record<string, unknown> }, tmap))
      .sort((a, b) => (b.submitted || "").localeCompare(a.submitted || ""));
    payouts = precs.map(shapePayout).sort((a, b) => (b.payDate || "").localeCompare(a.payDate || ""));
    const name = String(ed.fields?.[E.name] ?? "");
    editor = {
      name,
      firstName: name.split(" ")[0] || name,
      email: s.email,
      rate: payoutNumber(ed.fields?.[E.rate]),
      payModel: selectName(ed.fields?.[E.payModel]) || "Per Video",
    };
  }
  return {
    editor,
    reviewer: reviewer ? { name: reviewer.name, firstName: reviewer.name.split(" ")[0] || reviewer.name, email: s.email } : null,
    videos,
    payouts,
    templates,
    nextPayday: nextPayday(),
  };
}

// Only active editors (or team members on their test logins) can submit.
async function requireEditor(s: { editorId: string | null; reviewerId: string | null }): Promise<string> {
  if (!s.editorId) throw new HttpError(403, "Only editors can submit videos.");
  const ed = await getEditor(s.editorId);
  if (selectName(ed.fields?.[E.status]) !== "Active" && !(s.reviewerId && await activeReviewer(s.reviewerId))) {
    throw new HttpError(403, "Your editor access has ended. Check with Raphael.");
  }
  return s.editorId;
}

function requiredSubmission(body: Record<string, unknown>) {
  const caption = clip(body.caption, 2200);
  const music = clip(body.music, 1000);
  if (!caption) throw new HttpError(400, "Add the caption.");
  if (!MUSIC_URL.test(music)) throw new HttpError(400, "Paste the Artlist link of the track you used.");
  return { caption, music };
}

async function submit(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  const editorId = await requireEditor(s);
  const title = clip(body.title, 200);
  const videoUrl = ourVideo(body.videoUrl);
  if (!videoUrl) throw new HttpError(400, "Upload the video file first.");
  if (!title) throw new HttpError(400, "Give the video a title.");
  const { caption, music } = requiredSubmission(body);
  const templateId = await pickTemplate(body.templateId, s);
  const fields: Record<string, unknown> = {
    [V.title]: title,
    [V.editor]: [editorId],
    [V.link]: videoUrl,
    [V.caption]: caption,
    [V.music]: music,
    [V.status]: "Submitted",
    [V.submitted]: viennaToday(),
  };
  if (templateId) fields[V.template] = [templateId];
  const data = await airtable(T_VIDEOS, { method: "POST", body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  return { id: data.records?.[0]?.id };
}

async function resubmit(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  const editorId = await requireEditor(s);
  const id = clip(body.id, 20);
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new HttpError(400, "Unknown video.");
  const videoUrl = ourVideo(body.videoUrl);
  if (!videoUrl) throw new HttpError(400, "Upload the new video file first.");
  const { caption, music } = requiredSubmission(body);

  const [rec] = await getVideos([id]) as { id: string; fields: Record<string, unknown> }[];
  const owner = (rec?.fields?.[V.editor] as string[] | undefined) ?? [];
  if (!rec || !owner.includes(editorId)) throw new HttpError(404, "Unknown video.");
  if (selectName(rec.fields[V.status]) !== "Needs Resubmission") throw new HttpError(400, "This video isn't waiting for changes.");

  const today = viennaToday();
  const prev = String(rec.fields[V.history] ?? "").trim();
  const entry = `${today} · Editor · New version submitted`;
  const fields: Record<string, unknown> = {
    [V.link]: videoUrl,
    [V.caption]: caption,
    [V.music]: music,
    [V.status]: "Submitted",
    [V.submitted]: today,
    [V.reviewed]: null,
    [V.history]: prev ? `${entry}\n\n${prev}` : entry,
  };
  await airtable(T_VIDEOS, { method: "PATCH", body: JSON.stringify({ records: [{ id, fields }], typecast: true }) });
  return { ok: true };
}

// ---------- review ----------

// Submitted or In Review rows that are already paid are old hourly work, not waiting for a review.
const QUEUE_FORMULA = `OR(AND(OR({Status}="Submitted",{Status}="In Review"),NOT({Paid})),{Status}="Needs Resubmission",AND({Status}="Approved",IS_AFTER({Review Date},DATEADD(TODAY(),-15,'days'))))`;

async function reviewQueue(req: Request) {
  const s = await sessionFrom(req);
  const reviewer = await requireReviewer(s);
  const fields = [V.title, V.editor, V.caption, V.status, V.notes, V.submitted, V.reviewed, V.link, V.music, V.reviewedBy, V.history, V.template]
    .map((f) => `fields[]=${f}`).join("&");
  const recs: { id: string; fields: Record<string, unknown> }[] = [];
  let offset = "";
  do {
    const data = await airtable(`${T_VIDEOS}?filterByFormula=${encodeURIComponent(QUEUE_FORMULA)}&${fields}&returnFieldsByFieldId=true&pageSize=100${offset ? `&offset=${offset}` : ""}`);
    recs.push(...(data.records ?? []));
    offset = data.offset ?? "";
  } while (offset && recs.length < 500);
  const [names, tlist] = await Promise.all([
    editorNames(),
    getTemplates().catch((e) => { console.error("templates", e); return [] as Template[]; }),
  ]);
  const tmap = new Map(tlist.map((t) => [t.id, t]));
  const videos = recs.map((r) => {
    const f = r.fields;
    const link = String(f[V.link] ?? "");
    const editorName = ((f[V.editor] as string[] | undefined) ?? []).map((id) => names.get(id) ?? "").filter(Boolean).join(", ");
    const t = templateOf(f, tmap);
    return {
      template: t ? editorTemplate(t) : null,
      id: r.id,
      title: String(f[V.title] ?? ""),
      editor: editorName || "Unknown editor",
      status: selectName(f[V.status]) || "Submitted",
      submitted: String(f[V.submitted] ?? ""),
      reviewed: String(f[V.reviewed] ?? ""),
      videoUrl: /^https:\/\//.test(link) ? link : "",
      caption: String(f[V.caption] ?? ""),
      music: webLink(f[V.music]),
      feedback: String(f[V.notes] ?? ""),
      reviewedBy: String(f[V.reviewedBy] ?? ""),
      history: String(f[V.history] ?? ""),
    };
  }).sort((a, b) => (a.submitted || "").localeCompare(b.submitted || ""));
  return { reviewer: { name: reviewer.name }, videos };
}

async function review(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  const reviewer = await requireReviewer(s);
  const id = clip(body.id, 20);
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new HttpError(400, "Unknown video.");
  const decision = String(body.decision ?? "");
  if (decision !== "approve" && decision !== "changes") throw new HttpError(400, "Choose Approve or Request changes.");
  const notes = clip(body.notes, 5000);
  if (decision === "changes" && !notes) throw new HttpError(400, "Write what needs changing, so the editor knows what to fix.");

  const [rec] = await getVideos([id]) as { id: string; fields: Record<string, unknown> }[];
  if (!rec) throw new HttpError(404, "That video isn't in Airtable any more.");
  if (selectName(rec.fields[V.status]) === "Approved") {
    throw new HttpError(409, "This video is already approved. If that needs undoing, change it in Airtable.");
  }

  const today = viennaToday();
  const status = decision === "approve" ? "Approved" : "Needs Resubmission";
  const label = decision === "approve" ? "Approved" : "Changes requested";
  const entry = `${today} · ${reviewer.name} · ${label}${notes ? `\n${notes}` : ""}`;
  const prev = String(rec.fields[V.history] ?? "").trim();
  const fields: Record<string, unknown> = {
    [V.status]: status,
    [V.notes]: notes,
    [V.reviewed]: today,
    [V.reviewedBy]: reviewer.name,
    [V.history]: prev ? `${entry}\n\n${prev}` : entry,
  };
  await airtable(T_VIDEOS, { method: "PATCH", body: JSON.stringify({ records: [{ id, fields }], typecast: true }) });
  return { ok: true, status };
}

// ---------- caption check ----------

let exampleCache: { at: number; list: { caption: string; why: string }[] } | null = null;
async function captionExamples() {
  if (exampleCache && Date.now() - exampleCache.at < 10 * 60 * 1000) return exampleCache.list;
  try {
    const fields = [CX.caption, CX.why].map((f) => `fields[]=${f}`).join("&");
    const formula = encodeURIComponent(`{Use in checker}`);
    const data = await airtable(`${T_CAPTIONS}?filterByFormula=${formula}&${fields}&returnFieldsByFieldId=true&pageSize=100`);
    const list = (data.records ?? [])
      .map((r: { fields: Record<string, unknown> }) => ({ caption: String(r.fields?.[CX.caption] ?? "").trim(), why: String(r.fields?.[CX.why] ?? "").trim() }))
      .filter((x: { caption: string }) => x.caption)
      .slice(0, 40);
    exampleCache = { at: Date.now(), list };
    return list;
  } catch (e) {
    console.error("caption examples", e);
    return exampleCache?.list ?? [];
  }
}

function captionSystem(examples: { caption: string; why: string }[]) {
  const ex = examples.length
    ? "Captions NLT likes (from our examples list in Airtable):\n" + examples.map((x) => `- ${x.caption.replace(/\s*\n+\s*/g, " / ")}${x.why ? ` (why it works: ${x.why})` : ""}`).join("\n") + "\n\n"
    : "";
  return `${VOICE_RULES}\n\n${ex}${VOICE_ANSWER}`;
}

async function checkCaption(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  const caption = clip(body.caption, 2200);
  if (!caption) throw new HttpError(400, "Write the caption first, then check it.");
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new HttpError(503, "The caption check isn't switched on yet.");

  const who = s.editorId ?? s.reviewerId ?? s.email;
  if (!await allow(`caption:${who}`, "1 hour", CHECKS_PER_HOUR)) throw new HttpError(429, "That's a lot of checks for one hour. Wait a bit, then check again.");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: captionSystem(await captionExamples()),
        messages: [{ role: "user", content: `Caption to check:\n\n${caption}` }],
        output_config: { format: { type: "json_schema", schema: CHECK_SCHEMA } },
      }),
    });
  } catch (e) {
    console.error("claude", e);
    throw new HttpError(504, "The check took too long. Try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    console.error("claude", res.status, await res.text());
    throw new HttpError(502, "The caption check isn't available right now. Try again in a minute.");
  }
  const data = await res.json();
  const text = (data.content ?? []).find((b: { type: string }) => b.type === "text")?.text ?? "";
  let out: { verdict?: string; spelling?: { wrong: string; right: string }[]; tone?: string[] };
  try { out = JSON.parse(text); } catch { throw new HttpError(502, "The caption check gave an answer we couldn't read. Try again."); }
  const spelling = (out.spelling ?? [])
    .filter((x) => x && x.wrong && x.right && x.wrong !== x.right && caption.includes(x.wrong))
    .slice(0, 12);
  const tone = (out.tone ?? []).filter((t) => typeof t === "string" && t.trim()).slice(0, 3);
  const verdict = ["ready", "small fixes", "needs work"].includes(out.verdict ?? "") ? out.verdict : (spelling.length || tone.length ? "small fixes" : "ready");
  return { verdict, spelling, tone };
}

// ---------- uploads ----------

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A one-hour signature for one Cloudinary video upload by this editor: their own folder, video formats only.
// The API secret never leaves the server; Cloudinary rejects uploads without a valid signature.
async function uploadSignature(req: Request) {
  const s = await sessionFrom(req);
  const editorId = await requireEditor(s);
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const secret = Deno.env.get("CLOUDINARY_API_SECRET");
  if (!apiKey || !secret) throw new HttpError(503, "Uploads aren't switched on yet. Try again later.");
  if (!await allow(`upload:${editorId}`, "1 hour", UPLOADS_PER_HOUR)) throw new HttpError(429, "That's a lot of uploads for one hour. Wait a bit, then try again.");
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `editor-portal/${editorId}`;
  // Cloudinary signs every sent parameter except file, api_key, cloud_name and resource_type, sorted by name.
  const signature = await sha1(`allowed_formats=${VIDEO_FORMATS}&folder=${folder}&timestamp=${timestamp}${secret}`);
  return { cloudName: CLOUD_NAME, apiKey, timestamp, folder, allowedFormats: VIDEO_FORMATS, signature };
}

async function logout(req: Request) {
  const s = await sessionFrom(req);
  await db.from("sessions").delete().eq("token_hash", await sha256(s.token));
  return { ok: true };
}

// ---------- team area (reviewers only) ----------
// Today, Publish, Templates and Insights. Every action here starts with requireReviewer, so editors never reach it.
// Publishing reuses the Airtable automations: the portal fills the Publishing row and ticks Send to Publer,
// the "Send to Publer" automation uploads it to Publer, "Check posted status" records it once it's live.
// Insights read Publer's post numbers (PUBLER_API_KEY secret) into Postgres, refreshed every few hours.

const T_PUBLISHING = "tblmZSmjJ9Bo4S0Ng";
const PB = {
  title: "fldCuGRpDfRSpQ8qz",
  submission: "flduiMNUakCOc03LK",
  video: "fldQttgeYZ6FdcAaS",
  caption: "fldD8MlVYROIQvH0K",
  channels: "fld2rZEUJub5OmUWO",
  publishAt: "fldSBE1UhGp8OEdi1",
  extra: "fld3zYRBAml6UYLPV",
  trial: "fldhTgo96eGhHtaB0",
  send: "fldEozK409cgYLUsq",
  status: "fldKalnALzBJi1IOM",
  log: "fldoVvKctzsacdmbo",
  athletes: "fldeLUZswDWC4usyw",
  postedAt: "fldHLCImT2xYeelJe",
  ig: "fldseunhkPjMDR81N",
  fb: "fldeLV1dVdj5DHjna",
  tt: "fldukHgOJWL9q1RUs",
  yt: "fld3pz8A9qinjHaWx",
  posts: "fldXtVZaIBQ6lWryV",
};
const T_ATHLETES = "tblBNdi20fT7jJ7ah";
const AT = { name: "fldvUmmLbdyC8oAWV", ig: "fld9DzX09xkEBBxDP" };
const V_IN_PAYOUT = "fldpeAOfsTBXFuMvV";
const CHANNELS = ["Instagram", "Facebook", "TikTok", "YouTube"];
const TRIAL_MODES = ["Auto-share if it performs", "Manual (share in Instagram)"];
const LEVELS = ["Simple", "Medium", "Advanced"];
const NETWORKS = ["instagram", "facebook", "youtube", "tiktok"];
const VIENNA = "Europe/Vienna";
const REC_ID = /^rec[A-Za-z0-9]{14}$/;

async function listAll(table: string, fields: string[], formula = "", max = 2000) {
  const out: { id: string; fields: Record<string, unknown> }[] = [];
  const f = fields.map((x) => `fields[]=${x}`).join("&");
  let offset = "";
  do {
    const data = await airtable(`${table}?${f}&returnFieldsByFieldId=true&pageSize=100${formula ? `&filterByFormula=${encodeURIComponent(formula)}` : ""}${offset ? `&offset=${offset}` : ""}`);
    out.push(...(data.records ?? []));
    offset = data.offset ?? "";
  } while (offset && out.length < max);
  return out;
}

// Vienna wall time for a moment, and the moment for a Vienna wall time (summer time included).
function viennaParts(ms: number) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: VIENNA, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
}
function viennaToUtc(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = viennaParts(guess);
    const [py, pm, pd] = p.date.split("-").map(Number);
    const [ph, pmin] = p.time.split(":").map(Number);
    guess += wall - Date.UTC(py, pm - 1, pd, ph, pmin);
  }
  return guess;
}
const dayNum = (isoDay: string) => Date.parse(`${isoDay}T00:00:00Z`) / 86400000;
const isoOfDay = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
// Monday of the week a Vienna date is in.
const mondayOf = (isoDay: string) => { const n = dayNum(isoDay); return isoOfDay(n - ((new Date(n * 86400000).getUTCDay() + 6) % 7)); };

function median(list: number[]): number | null {
  const v = list.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}
const per1k = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 10 : null);

// Athletes with their Instagram handle, cached for ten minutes.
let athleteCache: { at: number; map: Map<string, { id: string; name: string; handle: string }> } | null = null;
async function athleteMap() {
  if (athleteCache && Date.now() - athleteCache.at < 10 * 60_000) return athleteCache.map;
  const map = new Map<string, { id: string; name: string; handle: string }>();
  for (const r of await listAll(T_ATHLETES, [AT.name, AT.ig])) {
    map.set(r.id, { id: r.id, name: String(r.fields[AT.name] ?? "").trim(), handle: String(r.fields[AT.ig] ?? "").trim().replace(/^@/, "") });
  }
  athleteCache = { at: Date.now(), map };
  return map;
}

// ---- publishing ----

const lastLogEntry = (log: string) => {
  const parts = String(log || "").trim().split(/\n\s*\n/).filter(Boolean);
  return (parts[parts.length - 1] ?? "").slice(0, 700);
};

async function publishData() {
  const formula = `OR(AND({Publer Status}!='Already posted',{Publer Status}!='Posted'),IS_AFTER({Posted At},DATEADD(NOW(),-21,'days')))`;
  const [rows, ath, tlist, names] = await Promise.all([
    listAll(T_PUBLISHING, Object.values(PB).filter((x) => x !== PB.posts), formula),
    athleteMap(),
    getTemplates().catch(() => [] as Template[]),
    editorNames(),
  ]);
  const subIds = [...new Set(rows.flatMap((r) => (r.fields[PB.submission] as string[] | undefined) ?? []))];
  const subs = new Map((await getVideos(subIds) as { id: string; fields: Record<string, unknown> }[]).map((s) => [s.id, s]));
  const tmap = new Map(tlist.map((t) => [t.id, t]));
  const items = rows.map((r) => {
    const f = r.fields;
    const raw = selectName(f[PB.status]);
    const posted = raw === "Already posted" || raw === "Posted";
    const sub = subs.get(((f[PB.submission] as string[] | undefined) ?? [])[0] ?? "");
    const t = sub ? templateOf(sub.fields, tmap) : null;
    const pa = f[PB.publishAt] ? Date.parse(String(f[PB.publishAt])) : NaN;
    const po = f[PB.postedAt] ? Date.parse(String(f[PB.postedAt])) : NaN;
    const editorId = ((sub?.fields[V.editor] as string[] | undefined) ?? [])[0] ?? "";
    return {
      id: r.id,
      title: String(f[PB.title] ?? ""),
      caption: String(f[PB.caption] ?? ""),
      videoUrl: webLink(f[PB.video]),
      channels: ((f[PB.channels] as unknown[] | undefined) ?? []).map(selectName).filter((c) => CHANNELS.includes(c)),
      publishAt: Number.isFinite(pa) ? { iso: new Date(pa).toISOString(), ...viennaParts(pa) } : null,
      status: posted ? "Posted" : raw,
      sending: f[PB.send] === true,
      log: lastLogEntry(String(f[PB.log] ?? "")),
      athletes: ((f[PB.athletes] as string[] | undefined) ?? []).map((id) => ath.get(id)).filter(Boolean),
      extra: String(f[PB.extra] ?? ""),
      trial: selectName(f[PB.trial]),
      template: t ? { id: t.id, name: t.name, level: t.level, pay: t.pay } : null,
      editor: names.get(editorId) ?? "",
      submitted: sub ? String(sub.fields[V.submitted] ?? "") : "",
      postedAt: Number.isFinite(po) ? { iso: new Date(po).toISOString(), ...viennaParts(po) } : null,
      links: { instagram: webLink(f[PB.ig]), facebook: webLink(f[PB.fb]), tiktok: webLink(f[PB.tt]), youtube: webLink(f[PB.yt]) },
    };
  });
  const now = Date.now();
  const ready = items.filter((x) => x.status !== "Posted" && x.status !== "Scheduled" && x.status !== "Sending")
    .sort((a, b) => (a.submitted || "9").localeCompare(b.submitted || "9"));
  const scheduled = items.filter((x) => x.status === "Scheduled" && x.publishAt && Date.parse(x.publishAt.iso) > now - 3 * 3600_000)
    .sort((a, b) => a.publishAt!.iso.localeCompare(b.publishAt!.iso));
  const recent = items.filter((x) => x.status === "Posted" && x.postedAt && Date.parse(x.postedAt.iso) > now - 8 * 86400_000)
    .sort((a, b) => b.postedAt!.iso.localeCompare(a.postedAt!.iso));
  return { ready, scheduled, recent };
}

async function publishQueue(req: Request) {
  const s = await sessionFrom(req);
  await requireReviewer(s);
  const [data, ath] = await Promise.all([publishData(), athleteMap()]);
  return {
    ...data,
    athletes: [...ath.values()].filter((a) => a.name).sort((a, b) => a.name.localeCompare(b.name)),
    slots: ["07:00", "18:00"],
    today: viennaParts(Date.now()).date,
  };
}

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

async function publishSchedule(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  await requireReviewer(s);
  const id = clip(body.id, 20);
  if (!REC_ID.test(id)) throw new HttpError(400, "Unknown video.");
  const [rec] = await listAll(T_PUBLISHING, [PB.status, PB.send, PB.video], `RECORD_ID()="${id}"`);
  if (!rec) throw new HttpError(404, "That video isn't in the Publishing table any more.");
  const status = selectName(rec.fields[PB.status]);
  if (status === "Scheduled" || status === "Already posted" || status === "Posted") {
    throw new HttpError(409, status === "Scheduled" ? "This video is already scheduled. Change or cancel it in Publer." : "This video is already live.");
  }
  if (rec.fields[PB.send] === true) throw new HttpError(409, "This video is being sent to Publer right now. Wait a minute.");

  const caption = clip(body.caption, 2200);
  if (!caption) throw new HttpError(400, "Add the caption.");
  const channels = Array.isArray(body.channels) ? CHANNELS.filter((c) => (body.channels as unknown[]).includes(c)) : [];
  if (!channels.length) throw new HttpError(400, "Pick at least one channel.");
  const trial = clip(body.trial, 60);
  if (trial && !TRIAL_MODES.includes(trial)) throw new HttpError(400, "Pick normal reel or trial reel.");
  const extras = clip(body.extra, 200).split(/[,\s]+/).map((h) => h.replace(/^@/, "")).filter(Boolean);
  if (extras.some((h) => !HANDLE.test(h))) throw new HttpError(400, "Extra collaborators: Instagram handles only, separated by commas.");
  const ath = await athleteMap();
  const athleteIds = Array.isArray(body.athleteIds) ? (body.athleteIds as unknown[]).map(String).filter((a) => ath.has(a)).slice(0, 10) : null;

  let publishAt: string | null = null;
  if (body.draft !== true) {
    const date = clip(body.date, 10), time = clip(body.time, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new HttpError(400, "Pick a day and a time.");
    const ms = viennaToUtc(date, time);
    if (!Number.isFinite(ms) || ms < Date.now() + 5 * 60_000) throw new HttpError(400, "Pick a time at least 5 minutes from now.");
    if (ms > Date.now() + 120 * 86400_000) throw new HttpError(400, "Pick a time within the next four months.");
    publishAt = new Date(ms).toISOString();
  }
  const fields: Record<string, unknown> = {
    [PB.caption]: caption,
    [PB.channels]: channels,
    [PB.publishAt]: publishAt,
    [PB.extra]: extras.slice(0, 3).join(", "),
    [PB.trial]: trial || null,
    [PB.send]: true,
  };
  if (athleteIds) fields[PB.athletes] = athleteIds;
  await airtable(T_PUBLISHING, { method: "PATCH", body: JSON.stringify({ records: [{ id, fields }] }) });
  return { ok: true, draft: !publishAt };
}

// ---- open work and money ----

async function openWork() {
  const formula = `OR(AND(OR({Status}="Submitted",{Status}="In Review"),NOT({Paid})),AND({Status}="Approved",NOT({Paid})))`;
  const [rows, names] = await Promise.all([
    listAll(T_VIDEOS, [V.title, V.editor, V.status, V.submitted, V.paid, V.payout, V_IN_PAYOUT], formula),
    editorNames(),
  ]);
  const review = rows.filter((r) => ["Submitted", "In Review"].includes(selectName(r.fields[V.status])))
    .map((r) => ({
      id: r.id,
      title: String(r.fields[V.title] ?? ""),
      editor: names.get(((r.fields[V.editor] as string[] | undefined) ?? [])[0] ?? "") ?? "",
      status: selectName(r.fields[V.status]),
      submitted: String(r.fields[V.submitted] ?? ""),
    }))
    .sort((a, b) => (a.submitted || "9").localeCompare(b.submitted || "9"));
  const approved = rows.filter((r) => selectName(r.fields[V.status]) === "Approved");
  const owed = Math.round(approved.reduce((t, r) => t + payoutNumber(r.fields[V.payout]), 0) * 100) / 100;
  return { review, owed, owedVideos: approved.length };
}

// ---- Publer numbers ----

const PUBLER = "https://app.publer.com/api/v1";
const WORKSPACE_NAME = "Sports Attention Lab";
const REFRESH_EVERY_MS = 3 * 3600_000;
const LOOKBACK_DAYS = 120;

async function publer(path: string, workspace = "") {
  const key = Deno.env.get("PUBLER_API_KEY");
  if (!key) throw new HttpError(503, "Publer isn't connected yet.");
  const headers: Record<string, string> = { Authorization: `Bearer-API ${key}`, Accept: "application/json" };
  if (workspace) headers["Publer-Workspace-Id"] = workspace;
  const res = await fetch(PUBLER + path, { headers });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    console.error("publer refused", path, res.status, text.slice(0, 300));
    throw new HttpError(502, "Publer refused the request. The API key needs the Analytics permission.");
  }
  if (!res.ok) {
    console.error("publer", path, res.status, text.slice(0, 300));
    throw new HttpError(502, "Couldn't reach Publer. Try again in a minute.");
  }
  try { return JSON.parse(text); } catch { return {}; }
}
const asList = (x: unknown, ...keys: string[]): Record<string, unknown>[] => {
  if (Array.isArray(x)) return x as Record<string, unknown>[];
  for (const k of keys) {
    const v = (x as Record<string, unknown> | null)?.[k];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
};
function networkOf(x: Record<string, unknown>): string {
  const provider = String(x.provider ?? "").toLowerCase();
  if (NETWORKS.includes(provider)) return provider;
  const s = ["provider", "network", "type", "social_network", "name", "post_link", "link", "url"].map((k) => String(x[k] ?? "")).join(" ").toLowerCase();
  if (s.includes("instagram") || s.includes("ig_")) return "instagram";
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("youtube") || s.includes("youtu.be")) return "youtube";
  if (s.includes("facebook") || /\bfb\b/.test(s)) return "facebook";
  return "";
}
// A number Publer may send as a number, a string or an object with a value.
function metricOf(m: Record<string, unknown>, names: string[]): number | null {
  const keys = Object.keys(m);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n);
    if (!k) continue;
    let v = m[k];
    if (v && typeof v === "object") v = (v as Record<string, unknown>).value ?? (v as Record<string, unknown>).total ?? (v as Record<string, unknown>).count;
    const n2 = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
    if (Number.isFinite(n2)) return Math.round(n2);
  }
  return null;
}

async function getState(key: string) {
  const { data } = await db.from("app_state").select("value, updated_at").eq("key", key).maybeSingle();
  return data as { value: Record<string, unknown>; updated_at: string } | null;
}
async function setState(key: string, value: Record<string, unknown>) {
  await db.from("app_state").upsert({ key, value, updated_at: new Date().toISOString() });
}

async function publerSetup() {
  const cached = await getState("publer_setup");
  if (cached && Date.now() - Date.parse(cached.updated_at) < 24 * 3600_000) {
    return cached.value as { workspace: string; accounts: { id: string; network: string; name: string }[] };
  }
  const wsList = asList(await publer("/workspaces"), "workspaces", "data");
  const ws = wsList.find((w) => String(w.name ?? "").trim().toLowerCase() === WORKSPACE_NAME.toLowerCase()) ?? wsList[0];
  if (!ws) throw new HttpError(502, "No Publer workspace found for this API key.");
  const workspace = String(ws.id);
  const accounts = asList(await publer("/accounts", workspace), "accounts", "data")
    .map((a) => ({ id: String(a.id ?? ""), network: networkOf(a), name: String(a.name ?? "") }))
    .filter((a) => a.id && NETWORKS.includes(a.network));
  const value = { workspace, accounts };
  await setState("publer_setup", value);
  return value;
}

// Publer's chart data: { current: { followers: { data: [{ date, value }] } } }. Read tolerantly.
function chartPoints(d: unknown, id: string): { date: string; value: number }[] {
  const o = (d ?? {}) as Record<string, unknown>;
  const cur = (o.current as Record<string, unknown> | undefined)?.[id] ?? o[id]
    ?? (Array.isArray(o.charts) ? (o.charts as Record<string, unknown>[]).find((c) => c.id === id) : undefined);
  const c = (cur ?? {}) as Record<string, unknown>;
  const arr = (Array.isArray(cur) ? cur : c.data ?? c.series ?? c.points ?? []) as Record<string, unknown>[];
  return arr.map((x) => {
    const v = x.value ?? x.last_value ?? x.count;
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return { date: String(x.date ?? x.day ?? "").slice(0, 10), value: Number.isFinite(n) ? Math.round(n) : 0 };
  }).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.value > 0);
}

// Publer gives daily follower counts only for ranges of up to 7 days, so ask a week at a time.
// The first time an account is seen, go back about two months; after that, the last week is enough.
async function refreshFollowers(workspace: string, accounts: { id: string; network: string }[]) {
  const today = viennaParts(Date.now()).date;
  let sampled = false;
  for (const acc of accounts) {
    try {
      const { count } = await db.from("follower_counts").select("day", { count: "exact", head: true }).eq("account_id", acc.id);
      const weeks = count ? 1 : 9;
      const rows: Record<string, unknown>[] = [];
      for (let w = 0; w < weeks; w++) {
        const to = isoOfDay(dayNum(today) - 7 * w), from = isoOfDay(dayNum(to) - 6);
        const d = await publer(`/analytics/${encodeURIComponent(acc.id)}/chart_data?chart_ids[]=followers&from=${from}&to=${to}`, workspace);
        const pts = chartPoints(d, "followers");
        if (!pts.length && !sampled) { sampled = true; console.error("publer followers empty", acc.network, from, JSON.stringify(d).slice(0, 800)); }
        if (!pts.length && w > 0) break;
        for (const x of pts) rows.push({ account_id: acc.id, network: acc.network, day: x.date, followers: x.value, fetched_at: new Date().toISOString() });
      }
      const unique = [...new Map(rows.map((r) => [String(r.day), r])).values()];
      if (unique.length) {
        const { error } = await db.from("follower_counts").upsert(unique);
        if (error) console.error("follower_counts upsert", error);
      }
    } catch (e) {
      console.error("publer followers", acc.network, e);
    }
  }
}

let refreshing: Promise<void> | null = null;
async function refreshPubler(force = false) {
  if (!Deno.env.get("PUBLER_API_KEY")) return;
  if (!force) {
    const last = await getState("publer_refreshed");
    if (last && Date.now() - Date.parse(last.updated_at) < REFRESH_EVERY_MS) return;
  }
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { workspace, accounts } = await publerSetup();
    const now = Date.now();
    const from = new Date(now - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
    const to = new Date(now + 86400_000).toISOString().slice(0, 10);
    const rows: Record<string, unknown>[] = [];
    let sample: unknown = null;
    let failed = 0;
    for (const acc of accounts) {
      let got = 0;
      try {
        for (let page = 0; page < 15; page++) {
          const d = await publer(`/analytics/${encodeURIComponent(acc.id)}/post_insights?from=${from}&to=${to}&page=${page}`, workspace);
          const list = asList(d, "posts", "data");
          for (const p of list) {
            const m = ((p.analytics ?? p.metrics ?? p.insights ?? p.statistics ?? p.stats ?? p) as Record<string, unknown>) || {};
            const when = Date.parse(String(p.scheduled_at ?? p.published_at ?? p.created_at ?? ""));
            if (!p.id || !Number.isFinite(when)) continue;
            const row = {
              id: String(p.id),
              account_id: acc.id,
              network: acc.network,
              published_at: new Date(when).toISOString(),
              text: String(p.text ?? p.title ?? "").slice(0, 2200),
              views: metricOf(m, ["video_views", "videoviews", "views", "plays", "video_plays"]),
              reach: metricOf(m, ["reach", "impressions_unique"]),
              likes: metricOf(m, ["likes", "reactions", "like_count"]),
              comments: metricOf(m, ["comments", "comment_count"]),
              shares: metricOf(m, ["shares", "share_count"]),
              saves: metricOf(m, ["saves", "saved"]),
              raw: p,
              fetched_at: new Date().toISOString(),
            };
            if (row.views === null && row.likes === null && !sample) sample = { keys: Object.keys(p), metrics: m };
            rows.push(row);
          }
          got += list.length;
          const total = typeof (d as Record<string, unknown>)?.total === "number" ? (d as Record<string, number>).total : null;
          if (list.length < 10 || (total !== null && got >= total)) break;
        }
      } catch (e) {
        // One account failing (e.g. a network Publer has no analytics for) doesn't stop the others.
        console.error("publer insights", acc.network, acc.id, e);
        failed++;
      }
    }
    if (accounts.length && failed === accounts.length) throw new HttpError(502, "Couldn't read the numbers from Publer. Try again in a minute.");
    if (sample) console.error("publer post without numbers", JSON.stringify(sample).slice(0, 1500));
    // Links to the live posts (nice to have: the numbers are saved without them too).
    const links = new Map<string, string>();
    try {
      for (let page = 0; page < 12; page++) {
        const d = await publer(`/posts?state=published_posted&from=${from}&to=${to}&page=${page}`, workspace);
        const list = asList(d, "posts", "data");
        for (const p of list) if (p.id && webLink(p.post_link)) links.set(String(p.id), webLink(p.post_link));
        const pages = typeof (d as Record<string, unknown>)?.total_pages === "number" ? (d as Record<string, number>).total_pages : null;
        if (!list.length || (pages !== null && page + 1 >= pages)) break;
      }
    } catch (e) {
      console.error("publer links", e);
    }
    // Followers per account and day (non-fatal: the post numbers are saved either way).
    await refreshFollowers(workspace, accounts).catch((e) => console.error("publer followers", e));
    for (const r of rows) r.link = links.get(String(r.id)) ?? null;
    // One row per post, even if Publer lists a post twice across pages.
    const unique = [...new Map(rows.map((r) => [String(r.id), r])).values()];
    for (let i = 0; i < unique.length; i += 200) {
      const { error } = await db.from("publer_posts").upsert(unique.slice(i, i + 200));
      if (error) { console.error("publer_posts upsert", error); throw new HttpError(500, "Couldn't save the numbers. Try again."); }
    }
    // Today's count per post (Vienna day; the last refresh of the day wins), so a day's new views can be told apart.
    const day = viennaParts(Date.now()).date;
    const snaps = unique.map((r) => ({ post_id: r.id, account_id: r.account_id, network: r.network, day, views: r.views, reach: r.reach, fetched_at: new Date().toISOString() }));
    for (let i = 0; i < snaps.length; i += 200) {
      const { error } = await db.from("publer_post_days").upsert(snaps.slice(i, i + 200));
      if (error) { console.error("publer_post_days upsert", error); break; }
    }
    await setState("publer_refreshed", { posts: unique.length, accounts: accounts.length, failed });
  })().finally(() => { refreshing = null; });
  return refreshing;
}

type PostRow = { id: string; account_id: string; network: string; published_at: string; text: string; link: string | null; views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null };

async function loadPosts(network: string, days: number): Promise<PostRow[]> {
  let q = db.from("publer_posts")
    .select("id, account_id, network, published_at, text, link, views, reach, likes, comments, shares, saves")
    .gte("published_at", new Date(Date.now() - days * 86400_000).toISOString());
  if (network !== "all") q = q.eq("network", network);
  const { data, error } = await q.order("published_at", { ascending: false }).limit(4000);
  if (error) { console.error("publer_posts read", error); throw new HttpError(500, "Couldn't read the numbers. Try again."); }
  return (data ?? []) as PostRow[];
}

// Which of our videos each Publer post is: Publer Posts on the Publishing row (filled by Check posted status).
let postIndexCache: { at: number; map: Map<string, VideoInfo> } | null = null;
async function postIndex() {
  if (postIndexCache && Date.now() - postIndexCache.at < 10 * 60_000) return postIndexCache.map;
  const [rows, tlist, names, ath] = await Promise.all([
    listAll(T_PUBLISHING, [PB.title, PB.submission, PB.video, PB.posts, PB.athletes], `{Publer Posts}!=''`),
    getTemplates().catch(() => [] as Template[]),
    editorNames(),
    athleteMap(),
  ]);
  const subIds = [...new Set(rows.flatMap((r) => (r.fields[PB.submission] as string[] | undefined) ?? []))];
  const subs = new Map((await getVideos(subIds) as { id: string; fields: Record<string, unknown> }[]).map((s) => [s.id, s]));
  const tmap = new Map(tlist.map((t) => [t.id, t]));
  const map = new Map();
  for (const r of rows) {
    const sub = subs.get(((r.fields[PB.submission] as string[] | undefined) ?? [])[0] ?? "");
    const t = sub ? templateOf(sub.fields, tmap) : null;
    const info: VideoInfo = {
      id: sub?.id ?? "",
      // What the editor was paid for this video (Payout in Airtable), for cost per 1,000 views.
      pay: sub ? payoutNumber(sub.fields[V.payout]) || null : null,
      title: String(r.fields[PB.title] ?? ""),
      videoUrl: webLink(r.fields[PB.video]),
      editor: names.get(((sub?.fields[V.editor] as string[] | undefined) ?? [])[0] ?? "") ?? "",
      template: t ? { id: t.id, name: t.name, pay: t.pay, level: t.level } : null,
      athletes: ((r.fields[PB.athletes] as string[] | undefined) ?? []).map((id) => ath.get(id)?.name ?? "").filter(Boolean),
    };
    // Lines are "Channel | post ID | account ID | time". Some rows store a different post ID than Publer's
    // numbers use, so the account and the minute it went out (give or take two) find it too.
    for (const line of String(r.fields[PB.posts] ?? "").split("\n")) {
      const [, pid, acc, when] = line.split("|").map((x) => (x ?? "").trim());
      if (pid) map.set(pid, info);
      const t = Date.parse(when ?? "");
      if (acc && Number.isFinite(t)) {
        const m = Math.round(t / 60_000);
        for (let k = m - 2; k <= m + 2; k++) map.set(`${acc}@${k}`, info);
      }
    }
  }
  postIndexCache = { at: Date.now(), map };
  return map;
}

type VideoInfo = { id: string; pay: number | null; title: string; videoUrl: string; editor: string; template: { id: string; name: string; pay: number | null; level: string } | null; athletes: string[] };
// What the page gets about a video: no pay per video.
const shownVideo = (v: VideoInfo | null) => (v ? { title: v.title, videoUrl: v.videoUrl, editor: v.editor, template: v.template, athletes: v.athletes } : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

// Cost per 1,000 views from what editors were actually paid (each video once, even if it went out twice).
// perTypical: pay for an average video ÷ views of the typical video, so one viral post doesn't hide the cost.
// blended: everything paid ÷ all the views those videos got.
function costOf(posts: { info: VideoInfo | null; value: number }[]) {
  const paid = new Map<string, number>();
  const values: number[] = [];
  let views = 0;
  for (const { info, value } of posts) {
    if (!info?.pay || !info.id) continue;
    paid.set(info.id, info.pay);
    values.push(value);
    views += value;
  }
  if (!paid.size) return null;
  const spent = [...paid.values()].reduce((a, b) => a + b, 0);
  const pay = spent / paid.size;
  const typical = median(values);
  return {
    videos: paid.size, posts: values.length, pay: round2(pay), typical, spent: round2(spent), views,
    perTypical: typical ? round2((pay / typical) * 1000) : null,
    blended: views ? round2((spent / views) * 1000) : null,
  };
}
type Cluster = PostRow & { members: PostRow[]; networks: string[] };
function videoOf(index: Map<string, VideoInfo>, p: PostRow | Cluster): VideoInfo | null {
  const list = "members" in p ? p.members : [p];
  for (const m of list) {
    const v = index.get(m.id) ?? (m.account_id ? index.get(`${m.account_id}@${Math.round(Date.parse(m.published_at) / 60_000)}`) : undefined);
    if (v) return v;
  }
  return null;
}

// All channels: the same video on several channels counts once. Posts within 15 minutes of each other on
// different channels are one video; its number is views on Instagram, Facebook and YouTube plus TikTok reach.
function clusterPosts(posts: PostRow[]): Cluster[] {
  const out: Cluster[] = [];
  for (const p of posts.slice().sort((a, b) => a.published_at.localeCompare(b.published_at))) {
    const t = Date.parse(p.published_at);
    const c = out.find((x) => !x.networks.includes(p.network) && Math.abs(Date.parse(x.members[0].published_at) - t) <= 15 * 60_000);
    if (c) { c.members.push(p); c.networks.push(p.network); } else out.push({ ...p, members: [p], networks: [p.network] });
  }
  const add = (list: PostRow[], k: keyof PostRow) => { const v = list.map((m) => m[k]).filter((x) => x !== null && x !== undefined) as number[]; return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  for (const c of out) {
    const ig = c.members.find((m) => m.network === "instagram");
    const lead = ig ?? c.members[0];
    const views = c.members.map((m) => m.views ?? (m.network === "tiktok" ? m.reach : null)).filter((x) => x !== null) as number[];
    Object.assign(c, {
      id: lead.id, account_id: "", network: "all", text: lead.text, link: lead.link ?? c.members.find((m) => m.link)?.link ?? null,
      views: views.length ? views.reduce((a, b) => a + b, 0) : null,
      reach: add(c.members, "reach"), likes: add(c.members, "likes"), comments: add(c.members, "comments"),
      shares: add(c.members, "shares"), saves: add(c.members, "saves"),
    });
  }
  return out;
}

// Followers per day from follower_counts. A day's change is the count that day minus the day before, per account,
// added up over the accounts that have both days.
async function followerStats(network: string) {
  const today = viennaParts(Date.now()).date;
  let q = db.from("follower_counts").select("account_id, network, day, followers").gte("day", isoOfDay(dayNum(today) - 120));
  if (network !== "all") q = q.eq("network", network);
  const { data, error } = await q.limit(5000);
  if (error) { console.error("follower_counts read", error); return null; }
  const rows = (data ?? []) as { account_id: string; network: string; day: string; followers: number }[];
  if (!rows.length) return null;
  const byAcc = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!byAcc.has(r.account_id)) byAcc.set(r.account_id, new Map());
    byAcc.get(r.account_id)!.set(String(r.day).slice(0, 10), r.followers);
  }
  const changeOn = (day: string, accs: string[] = [...byAcc.keys()]) => {
    const prev = isoOfDay(dayNum(day) - 1);
    let sum = 0, any = false;
    for (const a of accs) {
      const m = byAcc.get(a); const x = m?.get(day), y = m?.get(prev);
      if (x !== undefined && y !== undefined) { sum += x - y; any = true; }
    }
    return any ? sum : null;
  };
  const sumOver = (from: number, to: number, accs?: string[]) => {
    let t = 0, any = false;
    for (let d = from; d <= to; d++) { const c = changeOn(isoOfDay(d), accs); if (c !== null) { t += c; any = true; } }
    return any ? t : null;
  };
  const now = [...byAcc.values()].reduce((t, m) => { const days = [...m.keys()].sort(); return t + (m.get(days[days.length - 1]) ?? 0); }, 0);
  const t0 = dayNum(today);
  const days = [];
  for (let i = 27; i >= 0; i--) { const d = isoOfDay(t0 - i); days.push({ date: d, change: changeOn(d), current: i === 0 }); }
  const thisMonday = mondayOf(today);
  const weeks = [];
  for (let i = 11; i >= 0; i--) { const s = dayNum(thisMonday) - 7 * i; weeks.push({ start: isoOfDay(s), change: sumOver(s, Math.min(s + 6, t0)), current: i === 0 }); }
  return {
    now, change7: sumOver(t0 - 6, t0), change28: sumOver(t0 - 27, t0),
    firstDay: rows.map((r) => String(r.day).slice(0, 10)).sort()[0],
    days, weeks,
    accounts: [...byAcc.keys()],
    changeOn,
  };
}

// Who brought the new followers. On a day an account gained followers, the gain goes to that account's posts in
// proportion to the views they got that day and the day before (Publer's follower count trails by about a day),
// whenever they were posted. A hand-set credit (follower_credits) wins for its day. Days we can't tell
// (no view counts per post yet for that account) stay unassigned.
async function followerCredits(fol: NonNullable<Awaited<ReturnType<typeof followerStats>>>, network: string, posts: PostRow[]) {
  const today = dayNum(viennaParts(Date.now()).date);
  const from = isoOfDay(today - 62);
  let q = db.from("publer_post_days").select("post_id, account_id, day, views, reach").gte("day", from);
  if (network !== "all") q = q.eq("network", network);
  const [snapRes, manualRes] = await Promise.all([q.limit(20000), db.from("follower_credits").select("account_id, day, post_id").gte("day", from)]);
  if (snapRes.error) console.error("publer_post_days read", snapRes.error);
  if (manualRes.error) console.error("follower_credits read", manualRes.error);
  const published = new Map(posts.map((p) => [p.id, dayNum(viennaParts(Date.parse(p.published_at)).date)]));
  const snaps = new Map<string, { account: string; byDay: Map<number, number> }>();
  const firstSnap = new Map<string, number>();
  for (const r of (snapRes.data ?? []) as { post_id: string; account_id: string; day: string; views: number | null; reach: number | null }[]) {
    const v = r.views ?? r.reach;
    if (v === null || v === undefined) continue;
    const d = dayNum(String(r.day).slice(0, 10));
    let sp = snaps.get(r.post_id);
    if (!sp) { sp = { account: r.account_id, byDay: new Map() }; snaps.set(r.post_id, sp); }
    sp.byDay.set(d, v);
    firstSnap.set(r.account_id, Math.min(firstSnap.get(r.account_id) ?? d, d));
  }
  const gainOn = (id: string, sp: { byDay: Map<number, number> }, d: number): number | null => {
    const now = sp.byDay.get(d);
    if (now === undefined) return null;
    const before = sp.byDay.get(d - 1);
    if (before !== undefined) return Math.max(0, now - before);
    const pub = published.get(id);
    return pub !== undefined && pub >= d - 1 ? now : null; // new post: all its views are new
  };
  const manual = new Map<string, string[]>();
  for (const m of (manualRes.data ?? []) as { account_id: string; day: string; post_id: string }[]) {
    const k = `${m.account_id}|${String(m.day).slice(0, 10)}`;
    manual.set(k, [...(manual.get(k) ?? []), m.post_id]);
  }
  const credits = new Map<string, { followers: number; days: string[] }>();
  const give = (id: string, n: number, day: string) => {
    const c = credits.get(id) ?? { followers: 0, days: [] };
    c.followers += n;
    if (!c.days.includes(day)) c.days.push(day);
    credits.set(id, c);
  };
  for (const acc of fol.accounts) {
    const accPosts = [...snaps.entries()].filter(([, sp]) => sp.account === acc);
    for (let d = today - 60; d <= today; d++) {
      const day = isoOfDay(d);
      const c = fol.changeOn(day, [acc]);
      if (c === null || c <= 0) continue;
      const man = manual.get(`${acc}|${day}`);
      if (man?.length) { for (const id of man) give(id, c / man.length, day); continue; }
      // Every post needs a count from two days before, or the day can't be split fairly.
      if ((firstSnap.get(acc) ?? Infinity) > d - 2) continue;
      const gains = accPosts.map(([id, sp]) => ({ id, g: (gainOn(id, sp, d - 1) ?? 0) + (gainOn(id, sp, d) ?? 0) })).filter((x) => x.g > 0);
      const total = gains.reduce((t, x) => t + x.g, 0);
      if (!total) continue;
      for (const x of gains) give(x.id, (c * x.g) / total, day);
    }
  }
  return credits;
}

const firstLineOf = (s: string) => (String(s || "").split("\n").map((x) => x.trim()).find(Boolean) ?? "").slice(0, 140);

async function insights(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  await requireReviewer(s);
  if (!Deno.env.get("PUBLER_API_KEY")) return { connected: false };
  const network = NETWORKS.includes(String(body.channel)) ? String(body.channel) : "all";
  if (body.refresh === true) {
    if (!await allow("publer-refresh", "10 minutes", 4)) throw new HttpError(429, "Just refreshed. Try again in a few minutes.");
    await refreshPubler(true);
  } else {
    await refreshPubler(false).catch((e) => console.error("publer refresh", e));
  }
  const [raw, index, last, fol, email] = await Promise.all([
    loadPosts(network, LOOKBACK_DAYS), postIndex().catch(() => new Map<string, VideoInfo>()), getState("publer_refreshed"),
    followerStats(network).catch((e) => { console.error("follower stats", e); return null; }),
    emailStats().catch((e) => { console.error("email stats", e); return null; }),
  ]);
  const posts: (PostRow | Cluster)[] = network === "all" ? clusterPosts(raw) : raw;
  // TikTok: Publer gives reach, not views.
  const useReach = network === "tiktok" && !posts.some((p) => p.views !== null && p.views > 0);
  const val = (p: PostRow | Cluster) => (useReach ? p.reach : p.views) ?? null;
  const counted = posts.filter((p) => val(p) !== null);
  const dayOf = (p: PostRow | Cluster) => viennaParts(Date.parse(p.published_at)).date;
  const today = viennaParts(Date.now()).date;

  // Typical (median) video per week and per day.
  const thisMonday = mondayOf(today);
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const start = isoOfDay(dayNum(thisMonday) - 7 * i), end = isoOfDay(dayNum(start) + 6);
    const list = counted.filter((p) => { const d = dayOf(p); return d >= start && d <= end; });
    weeks.push({ start, end, posts: list.length, typical: median(list.map((p) => val(p)!)), total: list.reduce((t, p) => t + val(p)!, 0), current: i === 0 });
  }
  const days = [];
  for (let i = 27; i >= 0; i--) {
    const d = isoOfDay(dayNum(today) - i);
    const list = counted.filter((p) => dayOf(p) === d);
    days.push({ date: d, posts: list.length, typical: median(list.map((p) => val(p)!)), current: i < 2 });
  }
  const since = (n: number) => isoOfDay(dayNum(today) - n);
  const last28 = counted.filter((p) => dayOf(p) > since(28));
  const last30 = counted.filter((p) => dayOf(p) > since(30));
  const typical30 = median(last30.map((p) => val(p)!));
  const sum = (list: (PostRow | Cluster)[], k: keyof PostRow) => list.reduce((t, p) => t + (Number(p[k]) || 0), 0);
  const viewsIn = (list: (PostRow | Cluster)[]) => list.reduce((t, p) => t + (val(p) ?? 0), 0);
  const describe = (p: PostRow | Cluster) => {
    const info = videoOf(index, p);
    const v = val(p) ?? 0;
    return {
      id: p.id,
      caption: firstLineOf(p.text),
      date: dayOf(p),
      link: p.link ? webLink(p.link) : "",
      value: v,
      x: typical30 ? Math.round((v / typical30) * 10) / 10 : null,
      shares1k: per1k(Number(p.shares) || 0, v),
      likes1k: per1k(Number(p.likes) || 0, v),
      video: shownVideo(info),
      networks: "networks" in p ? p.networks : [p.network],
    };
  };
  const top = last30.slice().sort((a, b) => (val(b) ?? 0) - (val(a) ?? 0)).slice(0, 8).map(describe);

  // By template, last 90 days (our videos only).
  // Pay is what the editors were actually paid for those videos; the template's price until any are paid.
  const groups = new Map<string, { name: string; pay: number | null; level: string; values: number[]; shares: number; views: number; posts: { info: VideoInfo | null; value: number }[] }>();
  for (const p of counted.filter((x) => dayOf(x) > since(90))) {
    const info = videoOf(index, p);
    if (!info) continue;
    const key = info.template?.id ?? "own";
    const g = groups.get(key) ?? { name: info.template?.name ?? "Own idea", pay: info.template?.pay ?? null, level: info.template?.level ?? "", values: [] as number[], shares: 0, views: 0, posts: [] };
    g.values.push(val(p)!); g.shares += Number(p.shares) || 0; g.views += val(p)!;
    g.posts.push({ info, value: val(p)! });
    groups.set(key, g);
  }
  const byTemplate = [...groups.entries()].map(([id, g]) => {
    const typical = median(g.values);
    const pay = costOf(g.posts)?.pay ?? g.pay;
    return { id, name: g.name, level: g.level, pay, posts: g.values.length, typical, shares1k: per1k(g.shares, g.views), costPer1k: pay != null && typical ? round2((pay / typical) * 1000) : null };
  }).sort((a, b) => (b.typical ?? 0) - (a.typical ?? 0));

  // Posts that brought the most new followers (credited by the views they got on the days followers came in).
  let followers = null;
  if (fol) {
    const credits = await followerCredits(fol, network, raw).catch((e) => { console.error("follower credits", e); return new Map<string, { followers: number; days: string[] }>(); });
    const creditOf = (p: PostRow | Cluster) => {
      let n = 0; const days = new Set<string>();
      for (const m of "members" in p ? p.members : [p]) { const c = credits.get(m.id); if (c) { n += c.followers; c.days.forEach((x) => days.add(x)); } }
      return { n: Math.round(n), days: [...days].sort() };
    };
    const top = posts.map((p) => ({ p, c: creditOf(p) })).filter((x) => x.c.n > 0).sort((a, b) => b.c.n - a.c.n).slice(0, 8)
      .map(({ p, c }) => ({ ...describe(p), followers: c.n, followerDays: c.days }));
    const snapStart = await db.from("publer_post_days").select("day").order("day", { ascending: true }).limit(1);
    followers = { now: fol.now, change7: fol.change7, change28: fol.change28, firstDay: fol.firstDay, days: fol.days, weeks: fol.weeks, top,
      perPostFrom: (snapStart.data?.[0] as { day?: string } | undefined)?.day ?? null };
  }

  const thisWeek = weeks[11], lastWeek = weeks[10];
  return {
    connected: true,
    network,
    metric: useReach ? "reach" : "views",
    refreshedAt: last?.updated_at ?? null,
    kpis: {
      typicalThisWeek: thisWeek.typical, typicalLastWeek: lastWeek.typical,
      typical4w: median(last28.map((p) => val(p)!)), posts4w: last28.length,
      views4w: viewsIn(last28),
      shares1k: per1k(sum(last28, "shares"), viewsIn(last28)),
      likes1k: per1k(sum(last28, "likes"), viewsIn(last28)),
      cost: costOf(last28.map((p) => ({ info: videoOf(index, p), value: val(p)! }))),
    },
    weeks, days, top, byTemplate, followers, email,
  };
}

// Pages other than Insights don't wait for Publer: they show what's saved and refresh behind the scenes.
function refreshInBackground() {
  const p = refreshPubler(false).catch((e) => console.error("publer refresh", e));
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  rt?.waitUntil?.(p);
}

// Last week on Instagram, for the Today page.
async function weekSummary() {
  if (!Deno.env.get("PUBLER_API_KEY")) return null;
  refreshInBackground();
  const [posts, index] = await Promise.all([loadPosts("instagram", 8), postIndex().catch(() => new Map())]);
  const today = viennaParts(Date.now()).date;
  const from = isoOfDay(dayNum(today) - 7);
  const list = posts.filter((p) => p.views !== null && viennaParts(Date.parse(p.published_at)).date >= from && viennaParts(Date.parse(p.published_at)).date < today);
  const best = list.slice().sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0];
  return {
    from, to: isoOfDay(dayNum(today) - 1),
    posts: list.length,
    views: list.reduce((t, p) => t + (p.views ?? 0), 0),
    typical: median(list.map((p) => p.views!)),
    best: best ? { caption: firstLineOf(best.text), views: best.views, link: best.link ? webLink(best.link) : "", video: shownVideo(videoOf(index, best)) } : null,
  };
}

async function teamOverview(req: Request) {
  const s = await sessionFrom(req);
  const reviewer = await requireReviewer(s);
  const [pub, work, week, tlist, email] = await Promise.all([
    publishData(),
    openWork(),
    weekSummary().catch((e) => { console.error("week summary", e); return null; }),
    getTemplates().catch(() => [] as Template[]),
    emailStats().catch((e) => { console.error("email stats", e); return null; }),
  ]);
  const today = viennaParts(Date.now()).date;
  const lastPlanned = pub.scheduled.length ? pub.scheduled[pub.scheduled.length - 1].publishAt!.date : "";
  const active = tlist.filter((t) => t.active);
  return {
    reviewer: { name: reviewer.name, firstName: reviewer.name.split(" ")[0] || reviewer.name },
    today,
    review: { count: work.review.length, oldest: work.review[0]?.submitted ?? "", stuck: work.review.filter((v) => daysBetween(v.submitted, today) >= 3).slice(0, 6) },
    publish: {
      ready: pub.ready.length,
      oldestReady: pub.ready[0]?.submitted ?? "",
      scheduled: pub.scheduled,
      plannedUntil: lastPlanned,
      daysPlanned: lastPlanned ? Math.max(0, daysBetween(today, lastPlanned)) : 0,
      failed: pub.ready.filter((x) => x.status === "Failed").length,
    },
    pay: { nextPayday: nextPayday(), owed: work.owed, owedVideos: work.owedVideos },
    templates: { active: active.length, live: active.filter((t) => t.live).length, open: active.reduce((t, x) => t + (x.open ?? 0), 0) },
    week,
    email: email ? { total: email.total, confirmed: email.confirmed, new7: email.new7 } : null,
    publerConnected: !!Deno.env.get("PUBLER_API_KEY"),
  };
}
const daysBetween = (a: string, b: string) => (a && b ? Math.round(dayNum(b) - dayNum(a)) : 0);

// ---- email list ----
// Fans who gave their email in an Instagram or Facebook DM (ManyChat function, fans table). Only counts leave
// the server, never an address. Mailchimp asks everyone who didn't opt in to email in ManyChat to confirm by
// email; syncMailchimp() copies those statuses back every hour.

async function emailStats() {
  const { data, error } = await db.from("fans").select("source, mailchimp_status, mailchimp_error, carried_over, created_at").limit(50000);
  if (error) throw error;
  const rows = (data ?? []) as { source: string | null; mailchimp_status: string | null; mailchimp_error: string | null; carried_over: boolean; created_at: string }[];
  const today = viennaParts(Date.now()).date;
  const t0 = dayNum(today);
  const dayOf = (r: { created_at: string }) => viennaParts(Date.parse(r.created_at)).date;
  const fresh = rows.filter((r) => !r.carried_over);
  const from = rows.map(dayOf).sort()[0] ?? today;
  const perDay = new Map<string, number>();
  for (const r of fresh) perDay.set(dayOf(r), (perDay.get(dayOf(r)) ?? 0) + 1);
  // Days before the list started have no number (not 0), so the chart starts on the first day.
  const countFrom = (a: number, b: number) => {
    if (isoOfDay(b) < from) return null;
    let n = 0;
    for (let d = Math.max(a, dayNum(from)); d <= b; d++) n += perDay.get(isoOfDay(d)) ?? 0;
    return n;
  };
  const days = [];
  for (let i = 27; i >= 0; i--) days.push({ date: isoOfDay(t0 - i), change: countFrom(t0 - i, t0 - i), current: i === 0 });
  const weeks = [];
  const thisMonday = mondayOf(today);
  for (let i = 11; i >= 0; i--) { const s = dayNum(thisMonday) - 7 * i; weeks.push({ start: isoOfDay(s), change: countFrom(s, Math.min(s + 6, t0)), current: i === 0 }); }
  const status = (s: string) => rows.filter((r) => r.mailchimp_status === s).length;
  const synced = await getState("mailchimp_synced");
  return {
    total: rows.length,
    confirmed: status("subscribed"),
    pending: status("pending"),
    left: status("unsubscribed") + status("cleaned"),
    refused: rows.filter((r) => !r.mailchimp_status && r.mailchimp_error).length,
    instagram: rows.filter((r) => r.source === "manychat-instagram").length,
    facebook: rows.filter((r) => r.source === "manychat-facebook").length,
    new7: countFrom(t0 - 6, t0) ?? 0,
    new28: countFrom(t0 - 27, t0) ?? 0,
    carriedOver: rows.length - fresh.length,
    carriedOn: rows.filter((r) => r.carried_over).map(dayOf).sort()[0] ?? null,
    from,
    days, weeks,
    audience: (synced?.value?.audience as number | undefined) ?? null,
    syncedAt: synced?.updated_at ?? null,
  };
}

async function mailchimpApi() {
  const key = Deno.env.get("MAILCHIMP_API_KEY");
  const dc = key?.split("-").pop();
  if (!key || !dc || !/^[a-z]+\d+$/.test(dc)) return null;
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const headers = { Authorization: `Basic ${btoa(`nlt:${key}`)}`, Accept: "application/json" };
  let list = Deno.env.get("MAILCHIMP_AUDIENCE_ID") ?? "";
  if (!list) {
    const r = await fetch(`${base}/lists?count=10&fields=lists.id`, { headers });
    const b = await r.json().catch(() => ({})) as { lists?: { id: string }[] };
    if (!r.ok || b.lists?.length !== 1) throw new Error(`Mailchimp lists: HTTP ${r.status}, ${b.lists?.length ?? 0} audiences`);
    list = b.lists[0].id;
  }
  return { base, headers, list };
}

// Copies Mailchimp's status (pending, subscribed, unsubscribed, cleaned) onto the fans table: everyone the first
// time, then whoever changed since the last run. Runs with the hourly refresh.
async function syncMailchimp() {
  const mc = await mailchimpApi();
  if (!mc) return;
  const last = await getState("mailchimp_synced");
  // Anyone can call refresh-stats, so Mailchimp is asked at most every half hour.
  if (last && Date.now() - Date.parse(last.updated_at) < 30 * 60_000) return;
  const since = String(last?.value?.since ?? "");
  const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const status = new Map<string, string>();
  for (let offset = 0; offset < 50000; offset += 1000) {
    const q = new URLSearchParams({ count: "1000", offset: String(offset), fields: "members.email_address,members.status,total_items" });
    if (since) q.set("since_last_changed", since);
    const r = await fetch(`${mc.base}/lists/${mc.list}/members?${q}`, { headers: mc.headers });
    if (!r.ok) throw new Error(`Mailchimp members: HTTP ${r.status}`);
    const b = await r.json() as { members?: { email_address?: string; status?: string }[]; total_items?: number };
    for (const m of b.members ?? []) if (m.email_address && m.status) status.set(m.email_address.toLowerCase(), m.status);
    if (!b.members?.length || offset + 1000 >= (b.total_items ?? 0)) break;
  }
  const lr = await fetch(`${mc.base}/lists/${mc.list}?fields=stats.member_count`, { headers: mc.headers });
  const audience = lr.ok ? ((await lr.json()) as { stats?: { member_count?: number } }).stats?.member_count ?? null : null;
  if (status.size) {
    const { data, error } = await db.from("fans").select("email, mailchimp_status").limit(50000);
    if (error) throw error;
    const changes = new Map<string, string[]>();
    for (const f of (data ?? []) as { email: string; mailchimp_status: string | null }[]) {
      const s = status.get(f.email);
      if (s && s !== f.mailchimp_status) changes.set(s, [...(changes.get(s) ?? []), f.email]);
    }
    for (const [s, emails] of changes) {
      for (let i = 0; i < emails.length; i += 100) {
        const { error: ue } = await db.from("fans").update({ mailchimp_status: s, mailchimp_synced_at: new Date().toISOString(), mailchimp_error: null }).in("email", emails.slice(i, i + 100));
        if (ue) throw ue;
      }
    }
  }
  await setState("mailchimp_synced", { since: startedAt, audience });
}

// ---- templates admin ----

async function teamTemplates(req: Request) {
  const s = await sessionFrom(req);
  await requireReviewer(s);
  const [list, perf] = await Promise.all([
    getTemplates(),
    (async () => {
      if (!Deno.env.get("PUBLER_API_KEY")) return { by: new Map(), own: null };
      refreshInBackground();
      const [posts, index] = await Promise.all([loadPosts("instagram", 90), postIndex()]);
      const by = new Map<string, number[]>();
      const own: { info: VideoInfo | null; value: number }[] = [];
      for (const p of posts) {
        const info = videoOf(index, p);
        if (!info || p.views === null) continue;
        if (!info.template) { own.push({ info, value: p.views }); continue; }
        by.set(info.template.id, [...(by.get(info.template.id) ?? []), p.views]);
      }
      return { by: new Map([...by.entries()].map(([id, v]) => [id, { posted: v.length, typical: median(v) }])), own: costOf(own) };
    })().catch((e) => { console.error("template stats", e); return { by: new Map(), own: null }; }),
  ]);
  return {
    templates: list.map((t) => {
      const p = perf.by.get(t.id) as { posted: number; typical: number | null } | undefined;
      return { ...t, posted: p?.posted ?? 0, typical: p?.typical ?? null, costPer1k: t.pay != null && p?.typical ? round2((t.pay / p.typical) * 1000) : null };
    }),
    // Videos made without a template, to price templates against: Instagram, last 90 days.
    own: perf.own ? { posted: perf.own.posts, pay: perf.own.pay, typical: perf.own.typical, costPer1k: perf.own.perTypical } : null,
    levels: LEVELS,
  };
}

async function templateSave(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  await requireReviewer(s);
  const id = clip(body.id, 20);
  if (id && !REC_ID.test(id)) throw new HttpError(400, "Unknown template.");
  const name = clip(body.name, 80);
  if (!name) throw new HttpError(400, "Give the template a name.");
  const level = clip(body.level, 20);
  if (!LEVELS.includes(level)) throw new HttpError(400, "Pick a level: Simple, Medium or Advanced.");
  const numOrNull = (v: unknown, max: number, label: string, whole = false) => {
    if (v === null || v === undefined || String(v).trim() === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max || (whole && !Number.isInteger(n))) throw new HttpError(400, `${label} must be a number between 0 and ${max}.`);
    return whole ? n : Math.round(n * 100) / 100;
  };
  const pay = numOrNull(body.pay, 100, "Pay");
  const needed = numOrNull(body.needed, 500, "Needed", true);
  const example = clip(body.example, 1000);
  if (example && !/^https:\/\/\S+$/i.test(example)) throw new HttpError(400, "The example must be a link starting with https://.");
  const live = body.live === true;
  if (live) {
    let wasLive = false;
    if (id) {
      const [cur] = await listAll(T_TEMPLATES, [TP.live], `RECORD_ID()="${id}"`);
      if (!cur) throw new HttpError(404, "That template isn't in Airtable any more.");
      wasLive = cur.fields[TP.live] === true;
    }
    if (!wasLive && body.confirmLive !== true) throw new HttpError(400, "Confirm that editors may see this template and its pay.");
  }
  const fields: Record<string, unknown> = {
    [TP.name]: name,
    [TP.level]: level,
    [TP.pay]: pay,
    [TP.needed]: needed,
    [TP.example]: example || null,
    [TP.brief]: clip(body.brief, 4000),
    [TP.text]: clip(body.textOnScreen, 2000),
    [TP.caption]: clip(body.caption, 2000),
    [TP.music]: clip(body.music, 300),
    [TP.sound]: clip(body.sound, 2000),
    [TP.active]: body.active === true,
    [TP.live]: live,
  };
  const data = id
    ? await airtable(T_TEMPLATES, { method: "PATCH", body: JSON.stringify({ records: [{ id, fields }], typecast: true }) })
    : await airtable(T_TEMPLATES, { method: "POST", body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  postIndexCache = null;
  return { ok: true, id: data.records?.[0]?.id ?? id };
}

// ---------- router ----------

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, origin);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    switch (body.action) {
      case "request-code": return json(await requestCode(req, body), 200, origin);
      case "verify-code": return json(await verifyCode(req, body), 200, origin);
      case "dashboard": return json(await dashboard(req), 200, origin);
      case "submit": return json(await submit(req, body), 200, origin);
      case "resubmit": return json(await resubmit(req, body), 200, origin);
      case "review-queue": return json(await reviewQueue(req), 200, origin);
      case "review": return json(await review(req, body), 200, origin);
      case "check-caption": return json(await checkCaption(req, body), 200, origin);
      case "upload-signature": return json(await uploadSignature(req), 200, origin);
      case "team-overview": return json(await teamOverview(req), 200, origin);
      case "publish-queue": return json(await publishQueue(req), 200, origin);
      case "publish-schedule": return json(await publishSchedule(req, body), 200, origin);
      case "insights": return json(await insights(req, body), 200, origin);
      case "team-templates": return json(await teamTemplates(req), 200, origin);
      case "template-save": return json(await templateSave(req, body), 200, origin);
      // Safe to call from anywhere: refreshes Publer's numbers at most every 3 hours and Mailchimp's statuses at
      // most every half hour, and returns nothing.
      case "refresh-stats":
        await Promise.all([
          refreshPubler(false).catch((e) => console.error("scheduled refresh", e)),
          syncMailchimp().catch((e) => console.error("mailchimp sync", e)),
        ]);
        return json({ ok: true }, 200, origin);
      case "logout": return json(await logout(req), 200, origin);
      case "ping": return json({ ok: true }, 200, origin);
      default: return json({ error: "Unknown action." }, 400, origin);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
    console.error(e);
    return json({ error: "Something went wrong. Try again." }, 500, origin);
  }
});
