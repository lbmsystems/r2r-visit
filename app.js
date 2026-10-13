(function () {
  "use strict";

  var cfg = window.R2R_CONFIG || {};
  var API = (cfg.API_BASE || "").replace(/\/$/, "");
  var DEMO = !API;
  var TZ = "America/New_York";

  var form = document.getElementById("lead-form");
  var els = {
    title: document.getElementById("form-title"),
    sub: document.getElementById("form-sub"),
    slotFieldset: document.getElementById("slot-fieldset"),
    days: document.getElementById("slot-days"),
    times: document.getElementById("slot-times"),
    slotStatus: document.getElementById("slot-status"),
    submit: document.getElementById("submit-btn"),
    toggle: document.getElementById("mode-toggle"),
    switchLead: document.getElementById("switch-lead"),
    error: document.getElementById("form-error"),
    success: document.getElementById("success"),
    successTitle: document.getElementById("success-title"),
    successBody: document.getElementById("success-body"),
    introTitle: document.getElementById("intro-title"),
    introLede: document.getElementById("intro-lede"),
    tourExpect: document.getElementById("tour-expect")
  };

  var params = new URLSearchParams(location.search);
  var mode = params.has("info") ? "info" : "visit";
  var slots = [];
  var selectedDay = null;

  // ---------- Copy per mode ----------
  var COPY = {
    visit: {
      title: "Schedule a visit",
      sub: "Tell us a little about your family, then pick a time that works.",
      submit: "Book my visit",
      switchLead: "Not ready to visit?",
      toggle: "Get info first",
      introTitle: "Come see where<br />little roots grow.",
      introLede: "The best way to know if Root to Rise is right for your family is to visit. Bring your little one, meet our teachers, and spend some time in the space. Tours take about 30 minutes."
    },
    info: {
      title: "Get more info",
      sub: "Share a few details and we'll send you a personal note with everything you need to know.",
      submit: "Send me info",
      switchLead: "Ready to see the space?",
      toggle: "Schedule a visit instead",
      introTitle: "Let's get to know<br />each other.",
      introLede: "Not quite ready to visit? That's okay. Tell us a bit about your family and we'll follow up personally with tuition, schedules, and what a day at Root to Rise looks like."
    }
  };

  function applyMode() {
    var c = COPY[mode];
    els.title.textContent = c.title;
    els.sub.textContent = c.sub;
    els.submit.textContent = c.submit;
    els.switchLead.textContent = c.switchLead;
    els.toggle.textContent = c.toggle;
    els.introTitle.innerHTML = c.introTitle;
    els.introLede.textContent = c.introLede;
    els.slotFieldset.hidden = mode !== "visit";
    els.tourExpect.hidden = mode !== "visit";
    document.title = mode === "visit" ? "Visit Root to Rise Microschool" : "Get Info · Root to Rise Microschool";
    var p = new URLSearchParams(location.search);
    p.delete("info");
    var rest = p.toString();
    var qs = mode === "info" ? "?info" + (rest ? "&" + rest : "") : (rest ? "?" + rest : "");
    try { history.replaceState(null, "", location.pathname + qs + location.hash); } catch (e) {}
    hideError();
  }

  els.toggle.addEventListener("click", function () {
    mode = mode === "visit" ? "info" : "visit";
    applyMode();
    if (mode === "visit" && !slots.length) loadSlots();
    els.title.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ---------- Start month options ----------
  (function buildMonths() {
    var sel = form.elements.startMonth;
    var d = new Date();
    d.setDate(1);
    var n = cfg.MONTHS_AHEAD || 12;
    for (var i = 0; i < n; i++) {
      var y = d.getFullYear(), m = d.getMonth();
      var opt = document.createElement("option");
      opt.value = y + "-" + String(m + 1).padStart(2, "0") + "-01";
      opt.textContent = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      sel.appendChild(opt);
      d.setMonth(m + 1);
    }
    var flex = document.createElement("option");
    flex.value = "flexible";
    flex.textContent = "Not sure yet";
    sel.appendChild(flex);
  })();

  // Birthday: allow up to ~9 months ahead (due dates) and back ~6 years.
  (function bdayLimits() {
    var b = form.elements.childBirthday;
    var max = new Date(); max.setMonth(max.getMonth() + 9);
    var min = new Date(); min.setFullYear(min.getFullYear() - 6);
    b.max = max.toISOString().slice(0, 10);
    b.min = min.toISOString().slice(0, 10);
  })();

  // ---------- Tour slots ----------
  function demoSlots() {
    var out = [], base = new Date();
    var times = [[9, 30], [11, 0], [15, 30]];
    for (var day = 1, added = 0; added < 6 && day < 20; day++) {
      var d = new Date(base); d.setDate(base.getDate() + day);
      var dow = d.getDay();
      if (dow === 0 || dow === 6) continue;
      added++;
      times.forEach(function (t, i) {
        if ((day + i) % 4 === 0) return;
        var s = new Date(d); s.setHours(t[0], t[1], 0, 0);
        out.push({ id: "demo-" + day + "-" + i, start: s.toISOString(), minutes: 30, spotsLeft: ((day + i) % 3) + 1 });
      });
    }
    return out;
  }

  function dayKey(iso) {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
  }

  function loadSlots() {
    els.slotStatus.textContent = "Loading available times…";
    var p = DEMO
      ? Promise.resolve({ slots: demoSlots() })
      : fetch(API + "/slots", { headers: { Accept: "application/json" } }).then(function (r) {
          if (!r.ok) throw new Error("slots " + r.status);
          return r.json();
        });
    p.then(function (data) {
      slots = (data.slots || []).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
      renderDays();
    }).catch(function (err) {
      console.error("[r2r] could not load tour times:", err);
      els.days.innerHTML = "";
      els.times.innerHTML = "";
      els.slotStatus.innerHTML = "We couldn't load tour times right now. You can <button type=\"button\" class=\"link-btn\" id=\"fallback-info\">request info instead</button> and we'll reach out to schedule.";
      var fb = document.getElementById("fallback-info");
      if (fb) fb.addEventListener("click", function () { mode = "info"; applyMode(); });
    });
  }

  function renderDays() {
    els.days.innerHTML = "";
    els.times.innerHTML = "";
    form.elements.slotId.value = "";
    if (!slots.length) {
      els.slotStatus.innerHTML = "There are no open tour times right now. <button type=\"button\" class=\"link-btn\" id=\"fallback-info\">Request info</button> and we'll reach out with new dates.";
      var fb = document.getElementById("fallback-info");
      if (fb) fb.addEventListener("click", function () { mode = "info"; applyMode(); });
      return;
    }
    var seen = {};
    slots.forEach(function (s) {
      var k = dayKey(s.start);
      if (seen[k]) return;
      seen[k] = true;
      var d = new Date(s.start);
      var b = document.createElement("button");
      b.type = "button";
      b.className = "day-btn";
      b.setAttribute("role", "tab");
      b.dataset.day = k;
      b.innerHTML =
        '<span class="dow">' + d.toLocaleDateString("en-US", { weekday: "short", timeZone: TZ }) + "</span>" +
        '<span class="dnum">' + d.toLocaleDateString("en-US", { day: "numeric", timeZone: TZ }) + "</span>" +
        '<span class="mon">' + d.toLocaleDateString("en-US", { month: "short", timeZone: TZ }) + "</span>";
      b.addEventListener("click", function () { selectDay(k); });
      els.days.appendChild(b);
    });
    els.slotStatus.textContent = "Times shown in Eastern Time.";
    selectDay(Object.keys(seen)[0]);
  }

  function selectDay(k) {
    selectedDay = k;
    Array.prototype.forEach.call(els.days.children, function (b) {
      b.setAttribute("aria-selected", b.dataset.day === k ? "true" : "false");
    });
    els.times.innerHTML = "";
    form.elements.slotId.value = "";
    slots.filter(function (s) { return dayKey(s.start) === k; }).forEach(function (s) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "time-btn";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", "false");
      b.dataset.id = s.id;
      var t = new Date(s.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
      b.innerHTML = t + (s.spotsLeft === 1 ? "<small>1 spot left</small>" : "");
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(els.times.children, function (x) { x.setAttribute("aria-checked", "false"); });
        b.setAttribute("aria-checked", "true");
        form.elements.slotId.value = s.id;
        hideError();
      });
      els.times.appendChild(b);
    });
  }

  // ---------- Validation ----------
  function normalizePhone(raw) {
    var d = String(raw || "").replace(/\D/g, "");
    if (d.length === 10) return "+1" + d;
    if (d.length === 11 && d[0] === "1") return "+" + d;
    return null;
  }

  function showError(msg) { els.error.textContent = msg; els.error.hidden = false; }
  function hideError() { els.error.hidden = true; }

  function validate() {
    var bad = [];
    ["parentFirst", "parentLast", "email", "phone", "childFirst", "childBirthday", "startMonth"].forEach(function (n) {
      var el = form.elements[n];
      var ok = !!el.value.trim();
      if (n === "email") ok = ok && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value.trim());
      if (n === "phone") ok = ok && !!normalizePhone(el.value);
      el.classList.toggle("invalid", !ok);
      if (!ok) bad.push(el);
    });
    if (bad.length) {
      bad[0].focus();
      showError("Please check the highlighted fields.");
      return false;
    }
    if (mode === "visit" && !form.elements.slotId.value) {
      showError("Please pick a tour time, or choose “Get info first” below.");
      els.slotFieldset.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }
    return true;
  }

  form.addEventListener("input", function (e) {
    if (e.target.classList) e.target.classList.remove("invalid");
  });

  // ---------- Submit ----------
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    hideError();
    if (!validate()) return;

    var f = form.elements;
    var slot = slots.find(function (s) { return s.id === f.slotId.value; });
    var payload = {
      mode: mode,
      parentFirst: f.parentFirst.value.trim(),
      parentLast: f.parentLast.value.trim(),
      email: f.email.value.trim(),
      phone: normalizePhone(f.phone.value),
      childFirst: f.childFirst.value.trim(),
      childLast: f.childLast.value.trim(),
      childBirthday: f.childBirthday.value,
      startMonth: f.startMonth.value,
      notes: f.notes.value.trim(),
      slotId: mode === "visit" ? f.slotId.value : null,
      smsConsent: true,
      sourceUrl: location.href
    };

    els.submit.disabled = true;
    els.submit.textContent = "Sending…";

    var req = DEMO
      ? new Promise(function (res) { console.info("[demo] would submit", payload); setTimeout(function () { res({ ok: true }); }, 700); })
      : fetch(API + "/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; });
        });

    req.then(function (res) {
      if (res.ok) return done(slot);
      if (res.error === "slot_full") {
        showError("That time just filled up. Please choose another.");
        loadSlots();
      } else {
        showError("Something went wrong sending your info. Please try again, or email us directly.");
      }
      resetButton();
    }).catch(function () {
      showError("We couldn't reach our server. Please check your connection and try again.");
      resetButton();
    });
  });

  function resetButton() {
    els.submit.disabled = false;
    els.submit.textContent = COPY[mode].submit;
  }

  function done(slot) {
    var name = form.elements.parentFirst.value.trim();
    var child = form.elements.childFirst.value.trim();
    if (mode === "visit" && slot) {
      var when = new Date(slot.start).toLocaleString("en-US", {
        weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ
      });
      els.successTitle.textContent = "See you soon, " + name + "!";
      els.successBody.textContent = "Your visit is booked for " + when + " at 5700 Colfax Ave, Alexandria. We'll send a confirmation and a reminder the day before. Bring " + child + " along!";
    } else {
      els.successTitle.textContent = "Thank you, " + name + "!";
      els.successBody.textContent = "We'll be in touch personally within one business day with more about Root to Rise. We can't wait to learn more about " + child + ".";
    }
    form.hidden = true;
    els.success.hidden = false;
    els.success.focus();
    els.success.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- Init ----------
  applyMode();
  loadSlots();
})();
