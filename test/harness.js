#!/usr/bin/env node
/* SSR smoke harness (recreated from the pre-git /tmp/harness.js described in
   CLAUDE.md §5): compile app.jsx with Babel (classic runtime, matching the
   in-browser babel-standalone setup) and render the whole app with React 18
   renderToString against stubbed browser globals.

   Catches TDZ/reference crashes and render-path errors before any deploy.
   renderToString never runs effects, so no network or Supabase is touched.

   Usage: node test/harness.js   → must print HARNESS PASS */
"use strict";
const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");
const React = require("react");
const ReactDOMServer = require("react-dom/server");

const src = fs.readFileSync(path.join(__dirname, "..", "app.jsx"), "utf8");
const { code } = babel.transformSync(src, {
  filename: "app.jsx",
  presets: [["@babel/preset-react", { runtime: "classic" }]],
});

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

/* Chainable, awaitable stand-in for the supabase client: every property is
   another stub, every call returns a stub, and awaiting one yields
   { data: null, error: null } so query/RPC code sees an empty backend. */
function sbStub() {
  return new Proxy(function () {}, {
    get(_t, p) {
      if (p === "then") return (resolve) => resolve({ data: null, error: null, count: 0 });
      return sbStub();
    },
    apply: () => sbStub(),
  });
}

function renderOnce(search) {
  const rendered = { html: null };
  const documentStub = {
    getElementById: () => ({}),
    createElement: () => ({ style: {}, setAttribute() {}, click() {}, remove() {} }),
    body: { appendChild() {}, removeChild() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowStub = {
    location: {
      search,
      hash: "",
      pathname: "/",
      hostname: "clubmajorsgolf.com",
      origin: "https://clubmajorsgolf.com",
      href: "https://clubmajorsgolf.com/" + search,
      replace() {},
      reload() {},
    },
    history: { replaceState() {}, pushState() {} },
    localStorage: memStorage(),
    sessionStorage: memStorage(),
    supabase: { createClient: () => sbStub() },
    SUPABASE_URL: "https://stub.supabase.co",
    SUPABASE_KEY: "stub-key",
    STRIPE_LINK_SINGLE: "",
    STRIPE_LINK_ANNUAL: "#",
    STRIPE_LINK_EVENT: "#",
    STRIPE_LINK_MAJOR: "#",
    STRIPE_LINK_SEASON: "#",
    open() {},
    confirm: () => true,
    alert() {},
    scrollTo() {},
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const ReactDOMStub = {
    createRoot: () => ({
      render: (el) => {
        rendered.html = ReactDOMServer.renderToString(el);
      },
    }),
  };
  const run = new Function(
    "React", "ReactDOM", "window", "document",
    "localStorage", "sessionStorage", "navigator", "fetch", "alert", "confirm",
    code
  );
  run(
    React, ReactDOMStub, windowStub, documentStub,
    windowStub.localStorage, windowStub.sessionStorage,
    { clipboard: { writeText: async () => {} } },
    () => new Promise(() => {}), // fetch: hang forever — effects never run in SSR anyway
    windowStub.alert, windowStub.confirm
  );
  if (!rendered.html) throw new Error("app never called createRoot().render()");
  return rendered.html;
}

try {
  const plain = renderOnce("");
  if (!plain.includes("ClubMajors")) throw new Error("plain render missing 'ClubMajors' marker");
  if (plain.length < 2000) throw new Error("plain render suspiciously small: " + plain.length + " chars");
  console.log("plain render: " + plain.length + " chars ✓");

  const demo = renderOnce("?demo=masters");
  if (!demo.includes("ClubMajors")) throw new Error("demo render missing 'ClubMajors' marker");
  if (demo.length < 2000) throw new Error("demo render suspiciously small: " + demo.length + " chars");
  console.log("demo render:  " + demo.length + " chars ✓");

  console.log("HARNESS PASS");
} catch (e) {
  console.error("HARNESS FAIL:", e && e.stack || e);
  process.exit(1);
}
