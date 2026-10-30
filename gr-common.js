/* gr-common.js — Golden Rule voice tools: the code every page shares.
 *   • storage + DOM helpers, "recent on this phone"
 *   • one access code for every tool (grTechCode), with the old per-tool keys migrated
 *   • GR.api(): the Apps Script call with a timeout, "no signal" detection and the access-code check in one place
 *   • GR.boot(): the access-code card → init → app flow. With no signal the app still opens, using the lists the
 *     phone saved from its last successful init, and a "No signal" strip shows at the top.
 *   • GR.listen(): tap-to-talk (one phrase at a time, restarted while the button is on — Chrome on Android repeats
 *     words in continuous mode). Chrome's voice typing needs a connection; offline it says to use the keyboard mic.
 *   • GR.draft(): keeps what was dictated/typed on the phone until it's used, so nothing is lost without signal.
 *   • registers the service worker (sw.js) so every page opens offline after its first visit.
 * Load order on a page: config.js → gr-common.js → the page's own script. */
window.GR = (function () {
  var EP = window.GR_ENDPOINTS || {};
  var KEY = "grTechCode";
  var OLD_KEYS = ["grNewJobCode", "grDispatchCode", "grEstimateCode", "grOrderCode"];
  var AUTH_RE = /access code|Too many wrong/;
  var NET_TEXT = "📶 No signal — anything that needs the server waits until you're back in range.";

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function get(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function put(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function getJ(k, fallback) { try { var v = JSON.parse(get(k) || "null"); return v == null ? fallback : v; } catch (e) { return fallback; } }
  function show(node, on) { if (node) node.classList.toggle("hidden", !on); }
  function say(id, text, kind) { var m = $(id); if (!m) return; m.textContent = text || ""; m.className = "status" + (text ? " " + (kind || "ok") : ""); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function recent(tool, text) {
    var r = getJ("grRecent", []); if (!Array.isArray(r)) r = [];
    r.unshift({ tool: tool, text: text, at: Date.now() }); put("grRecent", JSON.stringify(r.slice(0, 20)));
  }
  function endpoint(key) { var u = EP[key]; return u && u.indexOf("https://") === 0 ? u : ""; }
  /** Everything saved on this phone that still has to reach the office (Job Notes, Job Clock presses, Board notes and line items). */
  function queued(key) {
    var keys = key ? [key] : ["grNotesOutbox", "grClockOutbox", "grBoardNotes", "grBoardLines"];
    return keys.reduce(function (n, k) { var b = getJ(k, []); return n + (Array.isArray(b) ? b.length : 0); }, 0);
  }

  /* ---------- access code ---------- */
  function code() {
    var c = get(KEY); if (c) return c;
    for (var i = 0; i < OLD_KEYS.length; i++) if (get(OLD_KEYS[i])) { c = get(OLD_KEYS[i]); put(KEY, c); return c; }
    return "";
  }
  function setCode(c) { put(KEY, c); }
  function forgetCode() { [KEY].concat(OLD_KEYS).forEach(drop); }

  /* ---------- "No signal" strip ---------- */
  var isOffline = false;
  function offline(on, text) {
    isOffline = !!on;
    var b = $("grNet");
    if (on) {
      if (!b) { b = el("div"); b.id = "grNet"; b.setAttribute("role", "status"); document.body.insertBefore(b, document.body.firstChild); }
      b.textContent = text || NET_TEXT;
    } else if (b) b.parentNode.removeChild(b);
  }
  window.addEventListener("offline", function () { offline(true); });
  window.addEventListener("online", function () { offline(false); });

  /* ---------- server ---------- */
  /** One POST with a timeout. Resolves with the Response; rejects on no signal / timeout. */
  function post(url, data, timeoutMs) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 45000) : null;
    return fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(data), signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (timer) clearTimeout(timer); return r; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }
  /**
   * JSON call to one of the Apps Script web apps. Always resolves: {ok:false, error, net:true} when the server can't be
   * reached (no signal, timeout, or Google answered with an error page), so the page can keep what it was doing.
   * opts: { name, token, version, timeout, onAuthFail(msg), onOutdated(msg) }
   */
  function api(key, action, data, opts) {
    opts = opts || {}; data = data || {};
    data.action = action; data.token = opts.token || code();
    if (opts.version) data.v = opts.version;
    var url = endpoint(key);
    if (!url) return Promise.resolve({ ok: false, error: (opts.name || "This tool") + " isn't connected yet. Add its URL to config.js." });
    return post(url, data, opts.timeout)
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (r) { offline(false); return r; },
            function (e) {
              var http = /^http (\d+)/.exec(e && e.message || "");
              if (!http) offline(true);
              return { ok: false, net: true, error: http ? "The server had a problem (" + http[1] + "). Try again in a moment." : "Couldn't reach the server. Check your signal and try again." };
            })
      .then(function (r) {
        if (!r.ok && !r.net && r.outdated) { if (opts.onOutdated) opts.onOutdated(r.error); return r; }
        if (!r.ok && !r.net && action !== "init" && AUTH_RE.test(r.error || "")) { forgetCode(); if (opts.onAuthFail) opts.onAuthFail(r.error); }
        return r;
      });
  }
  /** A ready-made api() for one tool: var api = GR.client("newJob", {name: "New Job"}); api("parse", {...}). */
  function client(key, defaults) {
    return function (action, data, extra) {
      var o = {}; Object.keys(defaults || {}).forEach(function (k) { o[k] = defaults[k]; });
      Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
      return api(key, action, data, o);
    };
  }

  /* ---------- access-code card → init → app ---------- */
  /**
   * o: { key, name, init (false = no server check), version, ready(r, meta), onOutdated(msg), onForget() }
   *    ready() gets the init reply; with no signal it gets the reply this phone saved last time (meta.cached) or {}.
   * Returns { showCode(msg), showApp(), restart() }.
   */
  function boot(o) {
    var CACHE_K = "grInit:" + o.key;
    function showCode(msg) { show($("codeCard"), true); show($("app"), false); say("codeMsg", msg, "err"); }
    function showApp() { show($("codeCard"), false); show($("app"), true); say("codeMsg", ""); }
    function start(c, quiet) {
      if (o.init === false) { setCode(c); showApp(); o.ready({ ok: true }, { offline: false, cached: false }); return; }
      say("codeMsg", "Checking…", "busy");
      api(o.key, "init", {}, { token: c, version: o.version, name: o.name }).then(function (r) {
        if (r.ok) { setCode(c); put(CACHE_K, JSON.stringify({ at: Date.now(), r: r })); showApp(); o.ready(r, { offline: false, cached: false }); return; }
        if (r.net) {   // no signal: keep the code, open the app with what the phone saved last time
          var cached = getJ(CACHE_K, null);
          setCode(c); showApp();
          offline(true, cached ? "📶 No signal — showing what this phone saved last time. Anything that needs the server waits until you're back in range." : NET_TEXT);
          o.ready(cached ? cached.r : {}, { offline: true, cached: !!cached });
          return;
        }
        if (r.outdated) { setCode(c); show($("codeCard"), false); show($("app"), false); if (o.onOutdated) o.onOutdated(r.error); return; }
        forgetCode(); showCode(quiet ? "" : r.error);
      });
    }
    $("codeGo").onclick = function () { var c = $("code").value.trim(); if (c) start(c, false); };
    $("code").onkeydown = function (e) { if (e.key === "Enter") $("codeGo").click(); };
    var f = $("forget");
    if (f) f.onclick = function (e) { e.preventDefault(); forgetCode(); drop(CACHE_K); $("code").value = ""; if (o.onForget) o.onForget(); showCode(""); };
    var c = code();
    if (c) start(c, true); else showCode("");
    return { showCode: showCode, showApp: showApp, restart: function () { var c2 = code(); if (c2) start(c2, true); } };
  }

  /* ---------- drafts: what was dictated stays on the phone until it's used ---------- */
  var drafts = [];
  function draft(ta, key) {
    var k = "grDraft:" + key, t = null, restored = false;
    if (!ta.value && get(k)) { ta.value = get(k); restored = true; }
    function save() { if (ta.value.trim()) put(k, ta.value); else drop(k); }
    ta.addEventListener("input", function () { clearTimeout(t); t = setTimeout(save, 300); });
    var d = { save: save, clear: function () { ta.value = ""; drop(k); }, restored: restored };
    drafts.push(d);
    return d;
  }
  function saveDrafts() { drafts.forEach(function (d) { d.save(); }); }
  document.addEventListener("visibilitychange", function () { if (document.hidden) saveDrafts(); });
  window.addEventListener("pagehide", saveDrafts);

  /* ---------- speech ---------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var active = null;
  /** Stop listening; if cb is given, call it once the last phrase has been written in. */
  function stopAll(cb) {
    if (!active) { if (cb) cb(); return; }
    if (cb) active.after.push(cb);
    active.keep = false;
    try { active.rec.stop(); } catch (e) {}
  }
  /**
   * opts: base() → text already in the box; onText(base, finalText, interimText); label(on); done(); onError(text, kind);
   *       continuous (default true: keep listening phrase after phrase until tapped again or 20 s of silence)
   */
  function listen(btn, opts) {
    if (!SR) return;
    if (active && active.btn === btn) { stopAll(); return; }
    stopAll();
    var state = { btn: btn, keep: opts.continuous !== false, rec: null, lastHeard: Date.now(), after: [] };
    var base = opts.base ? opts.base() : "";
    function begin() {
      var rec = new SR();
      rec.lang = "en-US"; rec.continuous = false; rec.interimResults = true; rec.maxAlternatives = 1;
      state.rec = rec;
      rec.onresult = function (ev) {
        var r = ev.results[ev.results.length - 1], text = r[0].transcript.trim();   // newest result only; Android resends earlier partials
        state.lastHeard = Date.now();
        opts.onText(base, r.isFinal ? text + " " : "", r.isFinal ? "" : text);
      };
      rec.onerror = function (ev) {
        if (ev.error === "not-allowed" || ev.error === "service-not-allowed") { state.keep = false; if (opts.onError) opts.onError("❌ Microphone is blocked. Allow microphone access for this site in your browser settings.", "err"); }
        else if (ev.error === "audio-capture") { state.keep = false; if (opts.onError) opts.onError("❌ No microphone found on this device.", "err"); }
        else if (ev.error === "network") { state.keep = false; if (opts.onError) opts.onError("📶 No signal for voice. Tap the box and use the microphone key on your keyboard instead — it works offline. What you say is saved on this phone.", "wait"); }
      };
      rec.onend = function () {
        base = opts.base ? opts.base() : base;
        var idle = Date.now() - state.lastHeard > 20000;
        if (state.keep && !idle && active === state) { try { begin(); } catch (e) { finish(); } } else finish();
      };
      rec.start();
    }
    function finish() {
      btn.classList.remove("rec");
      if (opts.label) opts.label(false);
      if (active === state) active = null;
      saveDrafts();
      var cbs = state.after; state.after = [];
      cbs.forEach(function (f) { f(); });
      if (opts.done) opts.done();
    }
    active = state;
    btn.classList.add("rec");
    if (opts.label) opts.label(true);
    try { begin(); } catch (e) { finish(); }
  }
  /** Wires a mic button to a textarea. extra: { label(on), done(), onError(text, kind), continuous } */
  function micFor(btn, ta, extra) {
    extra = extra || {};
    btn.onclick = function () {
      listen(btn, {
        continuous: extra.continuous,
        base: function () { var v = ta.value.trim(); return v ? v + " " : ""; },
        onText: function (base, fin, interim) { ta.value = (base + fin + interim).replace(/\s+/g, " ").trimStart(); },
        label: extra.label, done: extra.done, onError: extra.onError
      });
    };
  }

  /* ---------- service worker: every page opens with no signal after its first visit ---------- */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    try { navigator.serviceWorker.register("sw.js").catch(function () {}); } catch (e) {}
  }

  return { $: $, get: get, put: put, drop: drop, getJ: getJ, show: show, say: say, el: el, rid: rid, recent: recent, queued: queued,
           endpoint: endpoint, code: code, setCode: setCode, forgetCode: forgetCode, offline: offline, isOffline: function () { return isOffline; },
           post: post, api: api, client: client, boot: boot, draft: draft, saveDrafts: saveDrafts,
           speech: !!SR, listen: listen, stopAll: stopAll, micFor: micFor };
})();
