// NLT jobs backend: the video editor application form and the skills test on jobs.the-nlt.com.
// Holds the Airtable key so the public pages don't. Only creates rows, with a fixed set of fields.

const AIRTABLE = "https://api.airtable.com/v0/app9LXJtFUqO3VN0V";
const T_APPLICATIONS = "tblX7hn7jo8VoHfIp";
const T_SKILLS = "tblt44Na8ow5NkYFf";

const ALLOWED_ORIGINS = new Set([
  "https://jobs.the-nlt.com",
  ...(Deno.env.get("EXTRA_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);
const CLOUDINARY_VIDEO = /^https:\/\/res\.cloudinary\.com\/os1vbtid\/video\/upload\//;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function cors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://jobs.the-nlt.com",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });
}

const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const httpUrl = (v: unknown) => { const s = clip(v, 1000); return /^https?:\/\//i.test(s) ? s : ""; };

async function create(table: string, fields: Record<string, unknown>) {
  const token = Deno.env.get("AIRTABLE_JOBS_TOKEN");
  if (!token) throw new HttpError(503, "Applications aren't connected yet.");
  const res = await fetch(`${AIRTABLE}/${table}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    console.error("airtable", res.status, await res.text());
    throw new HttpError(502, "Couldn't save that. Try again in a minute.");
  }
}

async function apply(b: Record<string, unknown>) {
  if (clip(b.website, 200)) return { ok: true }; // honeypot: bots fill hidden fields
  const name = clip(b.name, 200);
  const email = clip(b.email, 200);
  if (!name) throw new HttpError(400, "Add your name.");
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Add a valid email address.");
  const skills = Array.isArray(b.skills) ? b.skills.slice(0, 12).map((s) => clip(s, 100)).filter(Boolean) : [];
  const fields: Record<string, unknown> = {
    "Name": name,
    "Email": email,
    "Phone": clip(b.phone, 60),
    "Languages Spoken and Written": clip(b.languages, 500),
    "Editing Software": clip(b.software, 500),
    "Years of Editing Experience": clip(b.experience, 60),
    "Additional Technical Skills": skills,
    "Portfolio Link": httpUrl(b.portfolio),
    "Availability (Hours per Week)": clip(b.availability, 60),
    "Anything Else": clip(b.anythingElse, 4000),
    "Application Status": "New",
  };
  for (const k of Object.keys(fields)) if (fields[k] === "" || (Array.isArray(fields[k]) && !(fields[k] as unknown[]).length)) delete fields[k];
  await create(T_APPLICATIONS, fields);
  return { ok: true };
}

async function skillsTest(b: Record<string, unknown>) {
  const recId = clip(b.recId, 20);
  if (!/^rec[A-Za-z0-9]{14}$/.test(recId)) throw new HttpError(400, "This link is missing your applicant reference.");
  const fields: Record<string, unknown> = {
    "Applicant Name": clip(b.name, 200),
    "Application": [recId],
  };
  const tasks = Array.isArray(b.tasks) ? b.tasks.slice(0, 3) : [];
  let hasVideo = 0;
  tasks.forEach((t: Record<string, unknown>, i: number) => {
    const n = i + 1;
    const link = httpUrl(t?.link);
    const file = clip(t?.fileUrl, 1000);
    if (link) fields[`Task ${n} Video Link`] = link;
    if (CLOUDINARY_VIDEO.test(file)) fields[`Task ${n} Video File`] = [{ url: file }];
    if (link || CLOUDINARY_VIDEO.test(file)) hasVideo++;
    fields[`Task ${n} Caption`] = clip(t?.caption, 2200);
    fields[`Task ${n} Time to Produce`] = clip(t?.time, 100);
  });
  if (hasVideo < 3) throw new HttpError(400, "Add a video for each of the three tasks.");
  await create(T_SKILLS, fields);
  return { ok: true };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, origin);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.action === "apply") return json(await apply(body), 200, origin);
    if (body.action === "skills-test") return json(await skillsTest(body), 200, origin);
    if (body.action === "ping") return json({ ok: true, airtable: !!Deno.env.get("AIRTABLE_JOBS_TOKEN") }, 200, origin);
    return json({ error: "Unknown action." }, 400, origin);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
    console.error(e);
    return json({ error: "Something went wrong. Try again." }, 500, origin);
  }
});
