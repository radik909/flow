/**
 * Production integration snippet (DESIGN.md §1, §4). Load this synchronously, early in
 * <head> — NOT with async/defer — so it runs before the browser paints anything:
 *
 *   <head>
 *     <script src="https://<your-host>/snippet.js"
 *             data-site-key="YOUR_SITE_KEY"
 *             data-api-base="https://<your-host>"
 *             data-timeout-ms="200"></script>
 *   </head>
 *
 * What this deliberately does NOT do (see DESIGN.md, Out of scope): no visual DOM
 * editor — only simple text/attribute replacement via data attributes, anything
 * fancier is the site's own JS via Experiments.get(); no retry/offline-queueing for
 * tracking calls; no cross-device identity.
 */
(function () {
  "use strict";

  // 1. Hide the page immediately — first statement, before anything else runs. This
  // only prevents flicker if this script tag is synchronous and early in <head>; if
  // it's async/defer or placed after body content, this line runs too late to help.
  document.documentElement.style.visibility = "hidden";

  var reveal = (function () {
    var revealed = false;
    return function () {
      if (revealed) return;
      revealed = true;
      document.documentElement.style.visibility = "";
    };
  })();

  // Belt-and-suspenders: whatever else happens below, the page must never stay hidden
  // indefinitely. This fires independently of the fetch's own timeout/abort handling,
  // so a bug in that logic can't leave visitors staring at a blank page.
  var safetyTimer = setTimeout(reveal, 2000);

  try {
    var currentScript =
      document.currentScript ||
      (function () {
        var scripts = document.getElementsByTagName("script");
        return scripts[scripts.length - 1];
      })();

    var siteKey = currentScript.getAttribute("data-site-key");
    var apiBase = currentScript.getAttribute("data-api-base") || new URL(currentScript.src).origin;
    // Anti-flicker hide-timeout — configurable per integration. This is distinct from
    // the assignment service's own compute budget (DESIGN.md §1's <10ms): it's the
    // network round-trip budget this snippet will wait before giving up and showing
    // default/control content. 200ms is a reasonable default for real-world network
    // variance; tune it per site with data-timeout-ms if needed (DESIGN.md §4).
    var timeoutMs = parseInt(currentScript.getAttribute("data-timeout-ms") || "200", 10);
    var experimentFilter = currentScript.getAttribute("data-experiments"); // optional comma list

    if (!siteKey) {
      console.warn("[experiments] data-site-key is required; skipping assignment.");
      clearTimeout(safetyTimer);
      reveal();
      return;
    }

    var visitorId = getOrCreateVisitorId();
    var readyCallbacks = [];
    var experimentsById = {};
    var settled = false;

    window.Experiments = {
      // Registers a callback that fires once assignment resolves OR the timeout is
      // hit — whichever first. Site code that wants to branch on assignment (rather
      // than relying on declarative data attributes) should use this instead of
      // reading window.Experiments synchronously, since assignment may not have
      // resolved yet when the site's own script runs.
      ready: function (cb) {
        if (settled) cb();
        else readyCallbacks.push(cb);
      },
      get: function (experimentId) {
        return experimentsById[experimentId] || null;
      },
      // Convenience wrapper so site code doesn't need to know which experiment a goal
      // belongs to — fires a conversion for every experiment this visitor is in.
      track: function (goalId) {
        for (var experimentId in experimentsById) {
          if (Object.prototype.hasOwnProperty.call(experimentsById, experimentId)) {
            sendBeacon(apiBase + "/track/conversion", {
              visitorId: visitorId,
              siteKey: siteKey,
              experimentId: experimentId,
              goalId: goalId,
            });
          }
        }
      },
    };

    var url = apiBase + "/assign?visitorId=" + encodeURIComponent(visitorId) + "&siteKey=" + encodeURIComponent(siteKey);
    if (experimentFilter) url += "&experiments=" + encodeURIComponent(experimentFilter);

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timedOut = false;
    var timeoutHandle = setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();
      settle();
    }, timeoutMs);

    fetch(url, { signal: controller ? controller.signal : undefined })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (timedOut) return; // too late — already fell back to defaults and revealed
        clearTimeout(timeoutHandle);
        experimentsById = (data && data.experiments) || {};
        applyDeclarativeVariants(experimentsById, apiBase, visitorId, siteKey);
        settle();
      })
      .catch(function (err) {
        if (!timedOut) console.warn("[experiments] /assign failed:", err);
        // On failure, experimentsById stays empty — default/control content (already
        // in the DOM) is what gets shown. No exposure is fired for content that was
        // never actually applied.
        settle();
      });

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      reveal();
      for (var i = 0; i < readyCallbacks.length; i++) readyCallbacks[i]();
    }
  } catch (err) {
    // Never let a bug in this snippet break the host page.
    console.warn("[experiments] snippet error:", err);
    clearTimeout(safetyTimer);
    reveal();
  }

  function getOrCreateVisitorId() {
    var cookieName = "_exp_vid";
    var existing = readCookie(cookieName);
    if (existing) return existing;

    var stored = safeStorageGet(cookieName);
    if (stored) return stored;

    var id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "vid-" + Date.now() + "-" + Math.random().toString(16).slice(2);

    writeCookie(cookieName, id);
    safeStorageSet(cookieName, id);
    return id;
  }

  function readCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function writeCookie(name, value) {
    try {
      var oneYear = 365 * 24 * 60 * 60;
      document.cookie = name + "=" + encodeURIComponent(value) + "; max-age=" + oneYear + "; path=/; SameSite=Lax";
    } catch (err) {
      // ignore — localStorage fallback below still applies
    }
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      // cookies/localStorage both unavailable — visitor gets a fresh id every load,
      // a known/accepted limitation (DESIGN.md, Out of scope).
    }
  }

  // Declarative text-replacement convention: any element with data-experiment-id
  // (matching an experiment the visitor is in) gets its textContent replaced by that
  // variant's `content.text`, if present. Anything more elaborate is left to the site's
  // own code via window.Experiments.get(). Exposure fires immediately after each DOM
  // write — not before — per DESIGN.md's "assignment ≠ exposure" rule.
  function applyDeclarativeVariants(experimentsById, apiBase, visitorId, siteKey) {
    var nodes = document.querySelectorAll("[data-experiment-id]");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var experimentId = node.getAttribute("data-experiment-id");
      var assignment = experimentsById[experimentId];
      if (!assignment) continue;

      if (assignment.content && typeof assignment.content.text === "string") {
        node.textContent = assignment.content.text;
      }

      sendBeacon(apiBase + "/track/exposure", {
        visitorId: visitorId,
        siteKey: siteKey,
        experimentId: experimentId,
        variantId: assignment.variantId,
      });
    }
  }

  function sendBeacon(url, body) {
    var json = JSON.stringify(body);
    if (navigator.sendBeacon) {
      // sendBeacon survives page unload, which matters for exposure/conversion calls
      // fired right as a visitor navigates away — a plain fetch could be cancelled.
      var blob = new Blob([json], { type: "application/json" });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: json, keepalive: true }).catch(
        function () {
          // Fire-and-forget: per DESIGN.md, a lost tracking event is acceptable, a
          // broken page is not (Out of scope: client-side retry).
        },
      );
    }
  }
})();
