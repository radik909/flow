/**
 * Shared tab bar for the static pages under public/ (experiments, demo, snippet test).
 * Include as the first element in <body> so it renders above page content:
 *   <body>
 *     <script src="/nav.js"></script>
 *     ...
 */
(function () {
  "use strict";

  var pages = [
    { href: "/experiments.html", label: "Experiments" },
    { href: "/sites.html", label: "Sites" },
    { href: "/demo.html", label: "Demo" },
    { href: "/snippet-test.html", label: "Snippet test" },
  ];

  var style = document.createElement("style");
  style.textContent =
    ".exp-nav { font-family: system-ui, sans-serif; display: flex; align-items: center; gap: 0.5rem;" +
    " padding: 0.75rem 1rem; background: #1a1a1a; }" +
    ".exp-nav .exp-nav-label { color: #888; font-size: 0.75rem; text-transform: uppercase;" +
    " letter-spacing: 0.05em; margin-right: 0.5rem; }" +
    ".exp-nav a { color: #ccc; text-decoration: none; font-size: 0.9rem; padding: 0.25rem 0.6rem;" +
    " border-radius: 0.25rem; }" +
    ".exp-nav a:hover { color: #fff; background: #333; }" +
    ".exp-nav a.active { color: #fff; background: #444; font-weight: 600; }";
  document.head.appendChild(style);

  var nav = document.createElement("nav");
  nav.className = "exp-nav";

  var label = document.createElement("span");
  label.className = "exp-nav-label";
  label.textContent = "Experiments service";
  nav.appendChild(label);

  var current = window.location.pathname;
  pages.forEach(function (page) {
    var a = document.createElement("a");
    a.href = page.href;
    a.textContent = page.label;
    if (current === page.href) a.classList.add("active");
    nav.appendChild(a);
  });

  document.body.insertBefore(nav, document.body.firstChild);
})();
