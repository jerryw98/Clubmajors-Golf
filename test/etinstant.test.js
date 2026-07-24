#!/usr/bin/env node
/* etInstant() timezone tests (recreated per CLAUDE.md §5): extract the helper
   from app.jsx by regex, eval it, assert 7:00 AM ET converts to the right UTC
   instant across EST/EDT and both DST boundaries (2026: Mar 8 / Nov 1). */
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "app.jsx"), "utf8");
const m = src.match(/function etInstant\([\s\S]*?\n\}/);
if (!m) { console.error("could not extract etInstant from app.jsx"); process.exit(1); }
const etInstant = eval("(" + m[0] + ")");

let n = 0;
function eq(actual, expected, label) {
  n++;
  if (actual !== expected) {
    console.error("FAIL [" + label + "]: got " + actual + ", want " + expected);
    process.exit(1);
  }
  console.log("ok " + n + " — " + label);
}

eq(etInstant("2026-07-16", 7, 0), "2026-07-16T11:00:00.000Z", "summer (EDT, UTC-4)");
eq(etInstant("2026-01-15", 7, 0), "2026-01-15T12:00:00.000Z", "winter (EST, UTC-5)");
eq(etInstant("2026-03-07", 7, 0), "2026-03-07T12:00:00.000Z", "day before spring-forward (EST)");
eq(etInstant("2026-03-08", 7, 0), "2026-03-08T11:00:00.000Z", "spring-forward day, 7am is post-jump (EDT)");
eq(etInstant("2026-11-01", 7, 0), "2026-11-01T12:00:00.000Z", "fall-back day, 7am is post-fallback (EST)");
eq(etInstant("2026-07-16", 0, 0), "2026-07-16T04:00:00.000Z", "midnight ET summer");
eq(etInstant("2026-09-24", 7, 0), "2026-09-24T11:00:00.000Z", "Presidents Cup round 1 (EDT)");

console.log("ETINSTANT PASS (" + n + " assertions)");
