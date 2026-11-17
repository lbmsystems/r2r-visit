/**
 * Root to Rise visit API (Cloudflare Worker)
 *
 * GET  /slots              -> open, future tour slots with room
 * POST /submit             -> creates a Lead (+ linked Student) in Airtable
 * POST /register/open      -> checks link + child's birthday, returns saved answers and documents
 * POST /register/save      -> saves answers; with submit:true, checks completeness and marks Submitted
 * POST /register/upload    -> creates a Documents record and attaches the family's file
 * POST /register/remove    -> deletes a family upload that staff haven't verified yet
 *
 * Registration only opens when staff set the Student's "Registration status" to
 * "Ready for registration" (or it is already "In progress"). Every call re-checks the
 * private link (the Student record ID) and the child's birthday. 5 wrong birthdays lock it.
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
    const allowed = (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean);
    const originOk = allowed.includes(origin.toLowerCase());
    const url = new URL(request.url);

    // Tour times are public, so any page may read them. Submissions only from our site.
    const cors = {
      "Access-Control-Allow-Origin": url.pathname === "/slots" ? "*" : (originOk ? origin : allowed[0] || "null"),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return json({
          ok: true,
          version: 3,
          hasToken: Boolean(env.AIRTABLE_TOKEN),
          base: env.AIRTABLE_BASE || null,
          allowedOrigins: allowed,
        }, 200, { ...cors, "Access-Control-Allow-Origin": "*" });
      }
      if (request.method === "GET" && url.pathname === "/slots") {
        return json({ slots: await openSlots(env) }, 200, cors, "no-store");
      }
      if (request.method === "POST" && url.pathname === "/submit") {
        if (allowed.length && !originOk) return json({ ok: false, error: "origin" }, 403, cors);
        return await submit(request, env, cors);
      }
      if (request.method === "POST" && url.pathname.startsWith("/register/")) {
        if (allowed.length && !originOk) return json({ ok: false, error: "origin" }, 403, cors);
        return await register(url.pathname.slice("/register/".length), request, env, cors);
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

// ---------------------------------------------------------------------------
// Registration (after a child is accepted)
// Field IDs, not names, so renaming a column in Airtable doesn't break the page.
// ---------------------------------------------------------------------------

const DOCS = "tblsQ7WC4xmihRzCF";

const SF = {
  first: "fldoUdzYCi6GIRHCl",
  last: "fldugTtbABv2asZql",
  birthday: "fld8ubNDgGyCVrHsN",
  docs: "fld6QVNWu3Y276Rfb",
  preferred: "fldbrzZ8zrdEtPZJo",
  allergies: "fldF1w1hzCgkoMdqc",
  emergency: "fldCbeDwqQNaei8Yc",
  pickups: "fldBM12z17GDBNXwr",
  support: "fldl87UxsAMvZUH8m",
  photo: "fldTDNy7HEFAB993u",
  regStatus: "fldTL9bk65wB6wV4V",
  pediatrician: "fldRxUUJggViO9VDS",
  guardian2: "fld1md6OcHnLo0voQ",
  address: "fld2vYBUxXabLrWwQ",
  medConsent: "fldhh9n4L0ioueX3m",
  handbook: "fldg4jUyU7RhigTsC",
  signedBy: "fldg5ZKkRrVALFb7G",
  submittedAt: "fldPEwhjsfpVKCLi7",
  tries: "fld83DPOJitKEvema",
  answers: "fldUkSL1TjAnPiQWd",
};

const DF = {
  name: "fldRpOfMzorEmpgkH",
  student: "fldZg5xTchER4KCrb",
  type: "fldmmcFexivwtwhDm",
  file: "fldwsX2qW1J8qZxGq",
  status: "fldN28h0GpVwBpb5k",
  confidential: "fldyE6kl0Vt7y3tqQ",
  licensing: "fldoGC83K9CfDUX6T",
  received: "fldK7lebEQ8YLavQ9",
  source: "fldNkFDcumyzq5ai9",
};

const REG_OPEN = ["Ready for registration", "In progress"];
const MAX_TRIES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // Airtable's direct-upload limit
const FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"];
const SUPPORT_PLANS = ["IEP", "504 Plan", "Informal accommodations"];

// What families are asked to upload. "type" must match a Type option in Documents.
// "when" shows the item only if the family's answers call for it.
const CHECKLIST = [
  { type: "Immunization record", label: "Immunization record", help: "From your child's doctor.", required: true, licensing: true },
  { type: "Physical / health form", label: "Physical exam / health form", help: "Completed and signed by your child's doctor.", required: true, licensing: true },
  { type: "Allergy or medical action plan", label: "Allergy or medical action plan", help: "The plan from your child's doctor.", when: "medical" },
  { type: "Medication authorization", label: "Medication authorization", help: "Only if your child will need medicine while with us.", when: "medical" },
  { type: "IEP", label: "IEP", help: "The most recent copy.", when: "iep" },
  { type: "504 Plan", label: "504 plan", help: "The most recent copy.", when: "504" },
  { type: "Custody or court order", label: "Custody or court order", help: "Any order that affects who can pick up your child.", when: "custody" },
  { type: "Other", label: "Anything else", help: "Optional. Anything else you'd like us to have on file." },
];

async function register(action, request, env, cors) {
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, cors); }

  const gate = await checkAccess(env, b);
  if (gate.error) return json({ ok: false, error: gate.error, triesLeft: gate.triesLeft }, gate.status, cors);
  const { id, f } = gate;
  const docIds = f[SF.docs] || [];

  if (action === "open") {
    const patch = {};
    if (f[SF.regStatus] === "Ready for registration") patch[SF.regStatus] = "In progress";
    if (f[SF.tries]) patch[SF.tries] = 0;
    if (Object.keys(patch).length) await at(env, "PATCH", `${T.students}/${id}`, { fields: patch });
    return json({
      ok: true,
      child: { first: f[SF.first] || "", last: f[SF.last] || "" },
      answers: readAnswers(f),
      docs: await docsFor(env, docIds),
      checklist: CHECKLIST.map(({ type, label, help, required, when }) => ({ type, label, help, required: !!required, when: when || null })),
    }, 200, cors);
  }

  if (action === "save") {
    const a = cleanAnswers(b.answers);
    const fields = { ...answersToFields(a), [SF.answers]: JSON.stringify(a) };
    if (b.submit) {
      const missing = missingItems(a, await docsFor(env, docIds));
      if (missing.length) return json({ ok: false, error: "incomplete", missing }, 422, cors);
      fields[SF.regStatus] = "Submitted";
      fields[SF.submittedAt] = new Date().toISOString();
    }
    await at(env, "PATCH", `${T.students}/${id}`, { fields });
    return json({ ok: true, submitted: !!b.submit }, 200, cors);
  }

  if (action === "upload") {
    const item = CHECKLIST.find((c) => c.type === b.type);
    if (!item) return json({ ok: false, error: "invalid_type" }, 400, cors);
    const contentType = str(b.contentType, 60).toLowerCase();
    if (!FILE_TYPES.includes(contentType)) return json({ ok: false, error: "file_type" }, 415, cors);
    const data = String(b.data || "");
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return json({ ok: false, error: "invalid_file" }, 400, cors);
    if (Math.floor((data.length * 3) / 4) > MAX_FILE_BYTES) return json({ ok: false, error: "too_large" }, 413, cors);
    const filename = (str(b.filename, 120).replace(/[^\w.\- ()]/g, "_") || "document");

    const childName = [f[SF.first], f[SF.last]].filter(Boolean).join(" ");
    const created = await at(env, "POST", DOCS, {
      records: [{
        fields: {
          [DF.name]: `${childName} – ${item.label}`,
          [DF.student]: [id],
          [DF.type]: item.type,
          [DF.status]: "Received",
          [DF.confidential]: true,
          [DF.licensing]: !!item.licensing,
          [DF.received]: todayET(),
          [DF.source]: "Family upload",
        },
      }],
    });
    const docId = created.records[0].id;

    const up = await fetch(
      `https://content.airtable.com/v0/${env.AIRTABLE_BASE}/${docId}/${DF.file}/uploadAttachment`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ contentType, file: data, filename }),
      },
    );
    if (!up.ok) {
      console.error(`Airtable upload -> ${up.status} ${await up.text()}`);
      await at(env, "DELETE", `${DOCS}/${docId}`).catch(() => {});
      return json({ ok: false, error: "upload_failed" }, 502, cors);
    }
    return json({ ok: true, docs: await docsFor(env, [...docIds, docId]) }, 200, cors);
  }

  if (action === "remove") {
    const docId = str(b.docId, 17);
    if (!docIds.includes(docId)) return json({ ok: false, error: "not_found" }, 404, cors);
    const doc = await at(env, "GET", `${DOCS}/${docId}?returnFieldsByFieldId=true`);
    // Families can only take back their own uploads, and only before staff verify them.
    if (doc.fields[DF.source] !== "Family upload" || doc.fields[DF.status] !== "Received") {
      return json({ ok: false, error: "locked_doc" }, 409, cors);
    }
    await at(env, "DELETE", `${DOCS}/${docId}`);
    return json({ ok: true, docs: await docsFor(env, docIds.filter((x) => x !== docId)) }, 200, cors);
  }

  return json({ ok: false, error: "not_found" }, 404, cors);
}

async function checkAccess(env, b) {
  const k = str(b.k, 17);
  const birthday = str(b.birthday, 10);
  if (!/^rec[A-Za-z0-9]{14}$/.test(k) || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return { error: "invalid", status: 400 };

  let rec;
  try {
    rec = await at(env, "GET", `${T.students}/${k}?returnFieldsByFieldId=true`);
  } catch (err) {
    if (/-> (403|404)\b/.test(err.message)) return { error: "not_found", status: 404 };
    throw err;
  }
  const f = rec.fields || {};
  const tries = f[SF.tries] || 0;
  const status = f[SF.regStatus];

  if (tries >= MAX_TRIES) return { error: "locked", status: 423 };
  if (status === "Submitted" || status === "Complete") return { error: "submitted", status: 409 };
  if (!REG_OPEN.includes(status)) return { error: "not_open", status: 403 };

  if (f[SF.birthday] !== birthday) {
    await at(env, "PATCH", `${T.students}/${k}`, { fields: { [SF.tries]: tries + 1 } });
    const left = MAX_TRIES - tries - 1;
    return left > 0 ? { error: "mismatch", status: 401, triesLeft: left } : { error: "locked", status: 423 };
  }
  return { id: k, f };
}

async function docsFor(env, ids) {
  const list = ids.filter((x) => /^rec[A-Za-z0-9]{14}$/.test(x)).slice(0, 90);
  if (!list.length) return [];
  const p = new URLSearchParams({
    filterByFormula: `OR(${list.map((x) => `RECORD_ID()='${x}'`).join(",")})`,
    returnFieldsByFieldId: "true",
  });
  [DF.type, DF.status, DF.file, DF.received, DF.source].forEach((x) => p.append("fields[]", x));
  const d = await at(env, "GET", `${DOCS}?${p}`);
  // File names only. Never send attachment URLs back to the browser.
  return (d.records || []).map((r) => ({
    id: r.id,
    type: r.fields[DF.type] || "Other",
    status: r.fields[DF.status] || "",
    received: r.fields[DF.received] || "",
    files: (r.fields[DF.file] || []).map((a) => a.filename),
    removable: r.fields[DF.source] === "Family upload" && r.fields[DF.status] === "Received",
  }));
}

function readAnswers(f) {
  try {
    if (f[SF.answers]) return cleanAnswers(JSON.parse(f[SF.answers]));
  } catch {}
  // First visit: start from anything staff already entered.
  return cleanAnswers({
    preferredName: f[SF.preferred],
    address: f[SF.address],
    pediatrician: f[SF.pediatrician],
    allergies: f[SF.allergies],
    hasMedical: Boolean(f[SF.allergies]),
    supportPlan: f[SF.support] || [],
    photoConsent: f[SF.photo],
    medicalConsent: f[SF.medConsent],
    handbook: f[SF.handbook],
  });
}

function cleanAnswers(x) {
  x = x && typeof x === "object" ? x : {};
  const people = (arr, n) => (Array.isArray(arr) ? arr : []).slice(0, n)
    .map((p) => ({ name: str(p?.name, 100), relationship: str(p?.relationship, 60), phone: str(p?.phone, 30) }))
    .filter((p) => p.name || p.phone);
  const g = x.guardian2 || {};
  return {
    preferredName: str(x.preferredName, 60),
    address: str(x.address, 300),
    guardian2: { name: str(g.name, 100), relationship: str(g.relationship, 60), phone: str(g.phone, 30), email: str(g.email, 120) },
    pediatrician: str(x.pediatrician, 200),
    hasMedical: !!x.hasMedical,
    allergies: str(x.allergies, 2000),
    supportPlan: (Array.isArray(x.supportPlan) ? x.supportPlan : []).filter((v) => SUPPORT_PLANS.includes(v)),
    hasCustody: !!x.hasCustody,
    emergency: people(x.emergency, 4),
    pickups: people(x.pickups, 6),
    pickupNotes: str(x.pickupNotes, 1000),
    photoConsent: !!x.photoConsent,
    medicalConsent: !!x.medicalConsent,
    handbook: !!x.handbook,
    signedBy: str(x.signedBy, 100),
  };
}

function answersToFields(a) {
  const line = (p) => [p.name, p.relationship && `(${p.relationship})`, p.phone && `– ${p.phone}`].filter(Boolean).join(" ");
  const g = a.guardian2;
  return {
    [SF.preferred]: a.preferredName,
    [SF.address]: a.address,
    [SF.guardian2]: g.name ? [line(g), g.email].filter(Boolean).join("\n") : "",
    [SF.pediatrician]: a.pediatrician,
    [SF.allergies]: a.hasMedical ? a.allergies : "",
    [SF.support]: a.supportPlan,
    [SF.emergency]: a.emergency.map(line).join("\n"),
    [SF.pickups]: [...a.pickups.map(line), a.pickupNotes && `Note: ${a.pickupNotes}`].filter(Boolean).join("\n"),
    [SF.photo]: a.photoConsent,
    [SF.medConsent]: a.medicalConsent,
    [SF.handbook]: a.handbook,
    [SF.signedBy]: a.signedBy,
  };
}

function missingItems(a, docs) {
  const has = (type) => docs.some((d) => d.type === type && d.files.length && d.status !== "Expired");
  const m = [];
  if (!a.address) m.push("Home address");
  if (!a.emergency.some((p) => p.name && p.phone)) m.push("At least one emergency contact with a phone number");
  if (!a.pickups.some((p) => p.name)) m.push("At least one person allowed to pick up");
  CHECKLIST.filter((c) => c.required).forEach((c) => { if (!has(c.type)) m.push(c.label); });
  if (!a.medicalConsent) m.push("Emergency medical consent");
  if (!a.handbook) m.push("Family handbook acknowledgment");
  if (!a.signedBy) m.push("Your signature (typed full name)");
  return m;
}

function str(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function todayET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
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
