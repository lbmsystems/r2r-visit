/**
 * Root to Rise visit API (Cloudflare Worker)
 *
 * GET  /slots   -> open, future tour slots with room
 * POST /submit  -> creates a Lead (+ linked Student) in Airtable
 *
 * Secrets / vars (set in Cloudflare, never in the repo):
 *   AIRTABLE_TOKEN   personal access token, scopes: data.records:read, data.records:write
 *                    access limited to the "R2R Microschool & Daycare" base
 *   AIRTABLE_BASE    appFqL2NQXCjG9Cc2
 *   ALLOWED_ORIGINS  comma list, e.g. https://visit.roottorisemicroschool.com
 */

const T = {
  leads: "tblPhrTfTQFp0K0Ov",
  students: "tbleVISkmpYcmzHMO",
  slots: "tblD6lO05zdAcG2DL",
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/slots") {
        return json({ slots: await openSlots(env) }, 200, cors, "public, max-age=30");
      }
      if (request.method === "POST" && url.pathname === "/submit") {
        if (allowed.length && !allowed.includes(origin)) return json({ ok: false, error: "origin" }, 403, cors);
        return await submit(request, env, cors);
      }
      return json({ ok: false, error: "not_found" }, 404, cors);
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: "server" }, 500, cors);
    }
  },
};

async function openSlots(env) {
  const params = new URLSearchParams({
    filterByFormula: "{Bookable}=1",
    "sort[0][field]": "Start",
    "sort[0][direction]": "asc",
    pageSize: "100",
  });
  ["Start", "Duration", "Spots left"].forEach((f) => params.append("fields[]", f));
  const data = await at(env, "GET", `${T.slots}?${params}`);
  return (data.records || []).map((r) => ({
    id: r.id,
    start: r.fields["Start"],
    minutes: r.fields["Duration"] ? Math.round(r.fields["Duration"] / 60) : 30,
    spotsLeft: r.fields["Spots left"] ?? 1,
  }));
}

async function submit(request, env, cors) {
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, cors); }

  const s = (v, max = 200) => String(v ?? "").trim().slice(0, max);
  const mode = b.mode === "info" ? "info" : "visit";
  const lead = {
    parentFirst: s(b.parentFirst), parentLast: s(b.parentLast),
    email: s(b.email), phone: s(b.phone, 20),
    childFirst: s(b.childFirst), childLast: s(b.childLast),
    childBirthday: s(b.childBirthday, 10), startMonth: s(b.startMonth, 10),
    notes: s(b.notes, 4000), slotId: s(b.slotId, 30), sourceUrl: s(b.sourceUrl, 500),
  };

  if (!lead.parentFirst || !lead.childFirst || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email) || !/^\+\d{10,15}$/.test(lead.phone)) {
    return json({ ok: false, error: "invalid" }, 400, cors);
  }

  // Re-check the slot server-side so two families can't grab the last spot.
  let slotOk = false;
  if (mode === "visit") {
    if (!/^rec[A-Za-z0-9]{14}$/.test(lead.slotId)) return json({ ok: false, error: "invalid_slot" }, 400, cors);
    const slot = await at(env, "GET", `${T.slots}/${lead.slotId}`);
    if (!slot.fields || slot.fields["Bookable"] !== 1) return json({ ok: false, error: "slot_full" }, 409, cors);
    slotOk = true;
  }

  const fields = {
    "Parent first name": lead.parentFirst,
    "Parent last name": lead.parentLast,
    "Email": lead.email,
    "Phone": lead.phone,
    "Notes from family": lead.notes || undefined,
    "Status": mode === "visit" ? "Tour booked" : "Inquiry",
    "Path": mode === "visit" ? "Visit form" : "Info request",
    "SMS consent": true,
    "Source URL": lead.sourceUrl || undefined,
    "Answers raw": JSON.stringify({ ...lead, mode }, null, 2),
  };
  if (/^\d{4}-\d{2}-01$/.test(lead.startMonth)) fields["Preferred start month"] = lead.startMonth;
  if (slotOk) fields["Tour slot"] = [lead.slotId];

  // typecast lets Airtable add the "Info request" Path option the first time it's used.
  const created = await at(env, "POST", T.leads, { records: [{ fields: clean(fields) }], typecast: true });
  const leadId = created.records[0].id;

  const student = {
    "Child first name": lead.childFirst,
    "Child last name": lead.childLast || undefined,
    "Lead": [leadId],
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(lead.childBirthday)) student["Birthday"] = lead.childBirthday;
  await at(env, "POST", T.students, { records: [{ fields: clean(student) }] });

  return json({ ok: true }, 200, cors);
}

async function at(env, method, path, body) {
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Airtable ${method} ${path.split("?")[0]} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
}

function json(obj, status, headers, cache = "no-store") {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": cache },
  });
}
