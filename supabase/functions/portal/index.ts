// NLT editor portal backend.
// The browser never sees an Airtable key: every read and write goes through here.
// Login: email -> 6-digit code by email -> session token (30 days).
// Each editor only ever gets their own videos and payouts, and never any bank or payment-method fields.
// Reviewers (Reviewers table, Active ticked) get the review queue and can approve or request changes.
// Caption check: spelling and NLT tone notes from Claude. Suggestions only; it never writes a caption.
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
const CLOUDINARY_VIDEO = /^https:\/\/res\.cloudinary\.com\/os1vbtid\/video\/upload\//;
const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

const CODE_TTL_MIN = 10;
const SESSION_DAYS = 30;
const MAX_CODES_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

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

// ---------- editors ----------

async function findEditorByEmail(email: string) {
  // email is validated against EMAIL_RE, so it holds no quotes or braces.
  const formula = encodeURIComponent(`LOWER(TRIM({Email}))="${email}"`);
  const fields = [E.name, E.email, E.status].map((f) => `fields[]=${f}`).join("&");
  const data = await airtable(`${T_EDITORS}?filterByFormula=${formula}&${fields}&returnFieldsByFieldId=true&maxRecords=1`);
  return data.records?.[0] ?? null;
}

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

// ---------- reviewers ----------

async function findReviewerByEmail(email: string) {
  const formula = encodeURIComponent(`AND(LOWER(TRIM({Email}))="${email}",{Active})`);
  const fields = [R.name, R.email, R.active].map((f) => `fields[]=${f}`).join("&");
  const data = await airtable(`${T_REVIEWERS}?filterByFormula=${formula}&${fields}&returnFieldsByFieldId=true&maxRecords=1`);
  return data.records?.[0] ?? null;
}

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

function shapeVideo(rec: { id: string; fields: Record<string, unknown> }) {
  const f = rec.fields;
  const link = String(f[V.link] ?? "");
  return {
    id: rec.id,
    title: String(f[V.title] ?? ""),
    status: selectName(f[V.status]) || "Submitted",
    submitted: String(f[V.submitted] ?? ""),
    reviewed: String(f[V.reviewed] ?? ""),
    videoUrl: /^https:\/\//.test(link) ? link : "",
    caption: String(f[V.caption] ?? ""),
    music: String(f[V.music] ?? ""),
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

async function requestCode(body: Record<string, unknown>) {
  const email = normaliseEmail(body.email);
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await db.from("login_codes").select("id", { count: "exact", head: true })
    .eq("email", email).gte("created_at", since);
  if ((count ?? 0) >= MAX_CODES_PER_HOUR) throw new HttpError(429, "Too many codes requested. Wait an hour, then try again.");

  const [editor, reviewer] = await Promise.all([findEditorByEmail(email), findReviewerByEmail(email)]);
  if (!editor && !reviewer) throw new HttpError(404, "That email isn't on the editor or reviewer list. Check with Raphael if you think this is wrong.");
  const person = String(editor?.fields?.[E.name] ?? reviewer?.fields?.[R.name] ?? "");

  const code = randomCode();
  const expires = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000).toISOString();
  const { error } = await db.from("login_codes").insert({ email, code_hash: await sha256(`${email}:${code}`), expires_at: expires });
  if (error) throw new HttpError(500, "Something went wrong. Try again.");
  try {
    await sendCodeEmail(email, person, code);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("mail", e);
    throw new HttpError(502, "Couldn't send the email. Try again in a minute.");
  }
  return { ok: true };
}

async function verifyCode(body: Record<string, unknown>) {
  const email = normaliseEmail(body.email);
  const code = String(body.code ?? "").replace(/\D/g, "");
  if (code.length !== 6) throw new HttpError(400, "Enter the 6-digit code from the email.");

  const { data: row } = await db.from("login_codes").select("id, code_hash, attempts, expires_at")
    .eq("email", email).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!row || new Date(row.expires_at) < new Date()) throw new HttpError(400, "That code has expired. Ask for a new one.");
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "Too many wrong codes. Ask for a new one.");
  if (row.code_hash !== await sha256(`${email}:${code}`)) {
    await db.from("login_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    throw new HttpError(400, "That code didn't work. Check the email and try again.");
  }
  await db.from("login_codes").delete().eq("email", email);

  const [editor, reviewer] = await Promise.all([findEditorByEmail(email), findReviewerByEmail(email)]);
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
    const r = await findReviewerByEmail(s.email);
    if (r) {
      s.reviewerId = r.id as string;
      await db.from("sessions").update({ reviewer_id: s.reviewerId }).eq("token_hash", await sha256(s.token));
    }
  }
  const [ed, reviewer] = await Promise.all([
    s.editorId ? getEditor(s.editorId) : Promise.resolve(null),
    s.reviewerId ? activeReviewer(s.reviewerId) : Promise.resolve(null),
  ]);
  if (!ed && !reviewer) throw new HttpError(401, "Your session has ended. Log in again.");
  let editor = null;
  let videos: ReturnType<typeof shapeVideo>[] = [];
  let payouts: ReturnType<typeof shapePayout>[] = [];
  if (ed) {
    const ids = (ed.fields?.[E.videos] as string[] | undefined) ?? [];
    const payoutIds = (ed.fields?.[E.payouts] as string[] | undefined) ?? [];
    // A payouts hiccup must never stop editors from seeing and submitting videos.
    const [vrecs, precs] = await Promise.all([
      getVideos(ids),
      getPayouts(payoutIds).catch((e) => { console.error("payouts", e); return []; }),
    ]);
    videos = vrecs.map((r) => shapeVideo(r as { id: string; fields: Record<string, unknown> }))
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
    nextPayday: nextPayday(),
  };
}

function requireEditor(s: { editorId: string | null }): string {
  if (!s.editorId) throw new HttpError(403, "Only editors can submit videos.");
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
  const editorId = requireEditor(s);
  const title = clip(body.title, 200);
  const videoUrl = clip(body.videoUrl, 1000);
  if (!CLOUDINARY_VIDEO.test(videoUrl)) throw new HttpError(400, "Upload the video file first.");
  if (!title) throw new HttpError(400, "Give the video a title.");
  const { caption, music } = requiredSubmission(body);
  const fields: Record<string, unknown> = {
    [V.title]: title,
    [V.editor]: [editorId],
    [V.link]: videoUrl,
    [V.caption]: caption,
    [V.music]: music,
    [V.status]: "Submitted",
    [V.submitted]: viennaToday(),
  };
  const data = await airtable(T_VIDEOS, { method: "POST", body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  return { id: data.records?.[0]?.id };
}

async function resubmit(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  const editorId = requireEditor(s);
  const id = clip(body.id, 20);
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new HttpError(400, "Unknown video.");
  const videoUrl = clip(body.videoUrl, 1000);
  if (!CLOUDINARY_VIDEO.test(videoUrl)) throw new HttpError(400, "Upload the new video file first.");
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

const QUEUE_FORMULA = `OR({Status}="Submitted",{Status}="In Review",{Status}="Needs Resubmission",AND({Status}="Approved",IS_AFTER({Review Date},DATEADD(TODAY(),-15,'days'))))`;

async function reviewQueue(req: Request) {
  const s = await sessionFrom(req);
  const reviewer = await requireReviewer(s);
  const fields = [V.title, V.editor, V.caption, V.status, V.notes, V.submitted, V.reviewed, V.link, V.music, V.reviewedBy, V.history]
    .map((f) => `fields[]=${f}`).join("&");
  const recs: { id: string; fields: Record<string, unknown> }[] = [];
  let offset = "";
  do {
    const data = await airtable(`${T_VIDEOS}?filterByFormula=${encodeURIComponent(QUEUE_FORMULA)}&${fields}&returnFieldsByFieldId=true&pageSize=100${offset ? `&offset=${offset}` : ""}`);
    recs.push(...(data.records ?? []));
    offset = data.offset ?? "";
  } while (offset && recs.length < 500);
  const names = await editorNames();
  const videos = recs.map((r) => {
    const f = r.fields;
    const link = String(f[V.link] ?? "");
    const editorName = ((f[V.editor] as string[] | undefined) ?? []).map((id) => names.get(id) ?? "").filter(Boolean).join(", ");
    return {
      id: r.id,
      title: String(f[V.title] ?? ""),
      editor: editorName || "Unknown editor",
      status: selectName(f[V.status]) || "Submitted",
      submitted: String(f[V.submitted] ?? ""),
      reviewed: String(f[V.reviewed] ?? ""),
      videoUrl: /^https:\/\//.test(link) ? link : "",
      caption: String(f[V.caption] ?? ""),
      music: String(f[V.music] ?? ""),
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
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await db.from("caption_checks").select("id", { count: "exact", head: true })
    .eq("who", who).gte("created_at", since);
  if ((count ?? 0) >= CHECKS_PER_HOUR) throw new HttpError(429, "That's a lot of checks for one hour. Wait a bit, then check again.");
  await db.from("caption_checks").insert({ who });

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

async function logout(req: Request) {
  const s = await sessionFrom(req);
  await db.from("sessions").delete().eq("token_hash", await sha256(s.token));
  return { ok: true };
}

// ---------- router ----------

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, origin);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    switch (body.action) {
      case "request-code": return json(await requestCode(body), 200, origin);
      case "verify-code": return json(await verifyCode(body), 200, origin);
      case "dashboard": return json(await dashboard(req), 200, origin);
      case "submit": return json(await submit(req, body), 200, origin);
      case "resubmit": return json(await resubmit(req, body), 200, origin);
      case "review-queue": return json(await reviewQueue(req), 200, origin);
      case "review": return json(await review(req, body), 200, origin);
      case "check-caption": return json(await checkCaption(req, body), 200, origin);
      case "logout": return json(await logout(req), 200, origin);
      case "ping": return json({ ok: true, airtable: !!Deno.env.get("AIRTABLE_PORTAL_TOKEN"), mail: !!Deno.env.get("MAIL_APP_PASSWORD"), checker: !!Deno.env.get("ANTHROPIC_API_KEY") }, 200, origin);
      default: return json({ error: "Unknown action." }, 400, origin);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
    console.error(e);
    return json({ error: "Something went wrong. Try again." }, 500, origin);
  }
});
