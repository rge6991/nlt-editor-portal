// ManyChat -> NLT email list.
// The ManyChat flow that asks fans for their email calls this URL once the email is in, with only the contact's
// ID (External Request, POST {"subscriber_id": "<Contact Id>"}). Nothing else in the request is trusted: name,
// email, Instagram handle and email opt-in are read back from ManyChat's API with NLT's own key
// (MANYCHAT_API_KEY secret), so calling this URL can't add made-up addresses.
// Works the same for Instagram and Facebook Messenger contacts.
// Each fan is saved in Postgres (fans). When MAILCHIMP_API_KEY is set, they're also added to the Mailchimp
// audience with the tag "Instagram DM" or "Facebook DM": subscribed if they opted in to email in ManyChat,
// otherwise Mailchimp sends them a confirmation email first. MAILCHIMP_AUDIENCE_ID picks the audience if the
// account has several.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { createHash } from "node:crypto";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

// Counts one request against a limit in Postgres (same rate_hit as the portal); false once the limit is reached.
async function allow(key: string, window: string, max: number) {
  const { data, error } = await db.rpc("rate_hit", { p_key: key, p_window: window, p_max: max });
  if (error) { console.error("rate_hit", error); throw new HttpError(500, "Something went wrong."); }
  return data === true;
}

type Contact = {
  first_name?: string; last_name?: string; email?: string; optin_email?: boolean; ig_username?: string;
  ig_id?: unknown; last_interaction?: string | null; ig_last_interaction?: string | null; last_input_text?: string | null;
  custom_fields?: { name?: string; value?: unknown }[]; tags?: { name?: string }[];
};

// Where the fan wrote to us: the channel of their latest message (Instagram or Facebook Messenger).
function channelOf(c: Contact): "instagram" | "facebook" {
  const ig = Date.parse(c.ig_last_interaction ?? "") || 0;
  const fb = Date.parse(c.last_interaction ?? "") || 0;
  if (ig || fb) return ig >= fb ? "instagram" : "facebook";
  return c.ig_id || c.ig_username ? "instagram" : "facebook";
}

async function manychatContact(id: string): Promise<Contact> {
  const key = Deno.env.get("MANYCHAT_API_KEY");
  if (!key) throw new HttpError(503, "ManyChat isn't connected yet.");
  const res = await fetch(`https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const body = await res.json().catch(() => ({})) as { status?: string; data?: Contact; message?: string };
  if (res.status === 401 || res.status === 403) {
    console.error("manychat refused", res.status, JSON.stringify(body).slice(0, 300));
    throw new HttpError(502, "ManyChat refused the API key.");
  }
  if (!res.ok || body.status !== "success" || !body.data) {
    console.error("manychat getInfo", res.status, JSON.stringify(body).slice(0, 300));
    throw new HttpError(404, "Unknown ManyChat contact.");
  }
  return body.data;
}

// ManyChat's own Email field, a custom field with "mail" in its name if the flow saved it there, or an address
// in the fan's last message (fans who answer the welcome DM with their email straight away, e.g. on Instagram
// on a computer, where the "I'm in!" button doesn't show).
function emailOf(c: Contact): string {
  const sys = clip(c.email, 254).toLowerCase();
  if (EMAIL_RE.test(sys)) return sys;
  for (const f of c.custom_fields ?? []) {
    const v = clip(f?.value, 254).toLowerCase();
    if (/mail/i.test(String(f?.name ?? "")) && EMAIL_RE.test(v)) return v;
  }
  const typed = clip(c.last_input_text, 500).match(/[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}/i)?.[0] ?? "";
  const cleaned = typed.replace(/[.!?]+$/, "").toLowerCase();
  return EMAIL_RE.test(cleaned) ? cleaned.slice(0, 254) : "";
}

// Adds or updates the fan in Mailchimp. Returns Mailchimp's status, or null when Mailchimp isn't connected.
async function toMailchimp(fan: { email: string; first_name: string; last_name: string; optin_email: boolean; source: string }) {
  const key = Deno.env.get("MAILCHIMP_API_KEY");
  if (!key) return null;
  const dc = key.split("-").pop();
  if (!dc || !/^[a-z]+\d+$/.test(dc)) throw new Error("MAILCHIMP_API_KEY doesn't end in its data centre, e.g. -us21.");
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const headers = { Authorization: `Basic ${btoa(`nlt:${key}`)}`, "Content-Type": "application/json" };
  let list = Deno.env.get("MAILCHIMP_AUDIENCE_ID") ?? "";
  if (!list) {
    const r = await fetch(`${base}/lists?count=10&fields=lists.id,lists.name`, { headers });
    const b = await r.json().catch(() => ({})) as { lists?: { id: string }[] };
    if (!r.ok) throw new Error(`Mailchimp lists: HTTP ${r.status}`);
    if (b.lists?.length !== 1) throw new Error(`Mailchimp has ${b.lists?.length ?? 0} audiences; set MAILCHIMP_AUDIENCE_ID.`);
    list = b.lists[0].id;
  }
  // Mailchimp addresses a member by the MD5 of the lowercased email.
  const hash = createHash("md5").update(fan.email).digest("hex");
  const put = await fetch(`${base}/lists/${list}/members/${hash}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      email_address: fan.email,
      // Only people who opted in to email in ManyChat are subscribed straight away; the rest confirm by email.
      status_if_new: fan.optin_email ? "subscribed" : "pending",
      merge_fields: { FNAME: fan.first_name, LNAME: fan.last_name },
    }),
  });
  const pb = await put.json().catch(() => ({})) as { status?: string; title?: string; detail?: string };
  if (!put.ok) throw new Error(`Mailchimp ${put.status}: ${pb.title ?? ""} ${pb.detail ?? ""}`.trim());
  const tag = await fetch(`${base}/lists/${list}/members/${hash}/tags`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tags: [{ name: fan.source === "manychat-facebook" ? "Facebook DM" : "Instagram DM", status: "active" }] }),
  });
  if (!tag.ok) console.error("mailchimp tag", tag.status, (await tag.text()).slice(0, 200));
  return String(pb.status ?? "");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const id = clip(body.subscriber_id ?? body.contact_id ?? body.id, 30);
    if (!/^\d{3,25}$/.test(id)) return json({ error: "Send the ManyChat contact ID as subscriber_id." }, 400);
    if (!await allow(`manychat:${id}`, "1 hour", 10)) return json({ error: "Too many requests for this contact." }, 429);
    if (!await allow("manychat:all", "1 minute", 300)) return json({ error: "Too many requests. Try again in a minute." }, 429);

    const c = await manychatContact(id);
    const email = emailOf(c);
    if (!email) return json({ ok: true, saved: false, reason: "No email on this contact yet." });
    const now = new Date().toISOString();
    const fan = {
      email,
      manychat_id: id,
      first_name: clip(c.first_name, 80),
      last_name: clip(c.last_name, 80),
      ig_username: clip(c.ig_username, 60).replace(/^@/, ""),
      optin_email: c.optin_email === true,
      source: `manychat-${channelOf(c)}`,
      tags: (c.tags ?? []).map((t) => clip(t?.name, 60)).filter(Boolean).slice(0, 30),
      updated_at: now,
    };
    const { error } = await db.from("fans").upsert(fan, { onConflict: "email" });
    if (error) { console.error("fans upsert", error); return json({ error: "Couldn't save the contact." }, 500); }

    // Mailchimp after answering, so ManyChat's flow never waits on it.
    const sync = (async () => {
      try {
        const status = await toMailchimp(fan);
        if (status !== null) await db.from("fans").update({ mailchimp_status: status, mailchimp_synced_at: new Date().toISOString(), mailchimp_error: null }).eq("email", email);
      } catch (e) {
        console.error("mailchimp", e);
        await db.from("fans").update({ mailchimp_error: String(e).slice(0, 300) }).eq("email", email);
      }
    })();
    (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(sync);
    return json({ ok: true, saved: true });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong." }, 500);
  }
});
