// NLT editor portal backend.
// The browser never sees an Airtable key: every read and write goes through here.
// Login: email -> 6-digit code by email -> session token (30 days).
// Each editor only ever gets their own videos, and never any bank or payment-method fields.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import nodemailer from "npm:nodemailer@6.9.16";

const AIRTABLE = "https://api.airtable.com/v0/app9LXJtFUqO3VN0V";
const T_EDITORS = "tbla4YKeVLmMN8Ay6";
const T_VIDEOS = "tblZm9wz5Truwc9au";

// Airtable field IDs (stable even if a field is renamed).
const E = {
  name: "fldFLDtCBfmeenmbA",
  email: "fldB6DAOCuMorquqi",
  status: "fldq9ZDw3Aisnrk41",
  rate: "fldBraYbnmNkX6dGm",
  payModel: "fldHvik5ne9dCqDuH",
  videos: "fld1fG1EktpR6rVz3",
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
  const fields = [E.name, E.email, E.status, E.rate, E.payModel, E.videos].map((f) => `fields[]=${f}`).join("&");
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
  const { data, error } = await db.from("sessions").select("editor_id, email, expires_at")
    .eq("token_hash", await sha256(token)).maybeSingle();
  if (error) throw new HttpError(500, "Something went wrong. Try again.");
  if (!data || new Date(data.expires_at) < new Date()) throw new HttpError(401, "Your session has ended. Log in again.");
  return { editorId: data.editor_id as string, email: data.email as string, token };
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

  const editor = await findEditorByEmail(email);
  if (!editor) throw new HttpError(404, "That email isn't on the editors list. Check with Raphael if you think this is wrong.");

  const code = randomCode();
  const expires = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000).toISOString();
  const { error } = await db.from("login_codes").insert({ email, code_hash: await sha256(`${email}:${code}`), expires_at: expires });
  if (error) throw new HttpError(500, "Something went wrong. Try again.");
  try {
    await sendCodeEmail(email, String(editor.fields?.[E.name] ?? ""), code);
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

  const editor = await findEditorByEmail(email);
  if (!editor) throw new HttpError(404, "That email isn't on the editors list.");
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from("sessions").insert({ token_hash: await sha256(token), editor_id: editor.id, email, expires_at: expires });
  if (error) throw new HttpError(500, "Something went wrong. Try again.");
  return { token };
}

async function dashboard(req: Request) {
  const s = await sessionFrom(req);
  const ed = await getEditor(s.editorId);
  const ids = (ed.fields?.[E.videos] as string[] | undefined) ?? [];
  const videos = (await getVideos(ids)).map((r) => shapeVideo(r as { id: string; fields: Record<string, unknown> }))
    .sort((a, b) => (b.submitted || "").localeCompare(a.submitted || ""));
  const name = String(ed.fields?.[E.name] ?? "");
  return {
    editor: {
      name,
      firstName: name.split(" ")[0] || name,
      email: s.email,
      rate: payoutNumber(ed.fields?.[E.rate]),
      payModel: selectName(ed.fields?.[E.payModel]) || "Per Video",
    },
    videos,
  };
}

async function submit(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  const title = clip(body.title, 200);
  const videoUrl = clip(body.videoUrl, 1000);
  if (!title) throw new HttpError(400, "Give the video a title.");
  if (!CLOUDINARY_VIDEO.test(videoUrl)) throw new HttpError(400, "Upload the video file first.");
  const music = clip(body.music, 1000);
  const fields: Record<string, unknown> = {
    [V.title]: title,
    [V.editor]: [s.editorId],
    [V.link]: videoUrl,
    [V.caption]: clip(body.caption, 2200),
    [V.status]: "Submitted",
    [V.submitted]: viennaToday(),
  };
  if (/^https?:\/\//i.test(music)) fields[V.music] = music;
  const data = await airtable(T_VIDEOS, { method: "POST", body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  return { id: data.records?.[0]?.id };
}

async function resubmit(req: Request, body: Record<string, unknown>) {
  const s = await sessionFrom(req);
  const id = clip(body.id, 20);
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new HttpError(400, "Unknown video.");
  const videoUrl = clip(body.videoUrl, 1000);
  if (!CLOUDINARY_VIDEO.test(videoUrl)) throw new HttpError(400, "Upload the new video file first.");

  const [rec] = await getVideos([id]) as { id: string; fields: Record<string, unknown> }[];
  const owner = (rec?.fields?.[V.editor] as string[] | undefined) ?? [];
  if (!rec || !owner.includes(s.editorId)) throw new HttpError(404, "Unknown video.");
  if (selectName(rec.fields[V.status]) !== "Needs Resubmission") throw new HttpError(400, "This video isn't waiting for changes.");

  const fields: Record<string, unknown> = {
    [V.link]: videoUrl,
    [V.caption]: clip(body.caption, 2200),
    [V.status]: "Submitted",
    [V.submitted]: viennaToday(),
    [V.reviewed]: null,
  };
  const music = clip(body.music, 1000);
  if (/^https?:\/\//i.test(music)) fields[V.music] = music;
  await airtable(T_VIDEOS, { method: "PATCH", body: JSON.stringify({ records: [{ id, fields }], typecast: true }) });
  return { ok: true };
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
      case "logout": return json(await logout(req), 200, origin);
      case "ping": return json({ ok: true, airtable: !!Deno.env.get("AIRTABLE_PORTAL_TOKEN"), mail: !!Deno.env.get("MAIL_APP_PASSWORD") }, 200, origin);
      default: return json({ error: "Unknown action." }, 400, origin);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
    console.error(e);
    return json({ error: "Something went wrong. Try again." }, 500, origin);
  }
});
