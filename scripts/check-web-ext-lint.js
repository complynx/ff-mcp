"use strict";

const fs = require("fs");

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Usage: node scripts/check-web-ext-lint.js REPORT.json");

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const expectedWarnings = new Set([
  "ANDROID_INCOMPATIBLE_API:userScripts.execute is not supported in Firefox for Android version 150.0",
  "INCOMPATIBLE_API:userScripts.execute is not supported in Firefox version 150.0",
]);
const unexpectedWarnings = report.warnings.filter(
  (warning) => !expectedWarnings.has(`${warning.code}:${warning.message}`),
);
const failures = [...report.errors, ...unexpectedWarnings];

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else {
  console.log(
    `web-ext lint passed with ${report.warnings.length} expected Firefox 150 compatibility warnings`,
  );
}
