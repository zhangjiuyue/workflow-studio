import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const protectedRoutes = [
  "admin.html",
  "assets.html",
  "create.html",
  "home.html",
  "settings/api.html",
  "team.html",
  "workflows.html",
  "workflows/run.html",
];

for (const route of protectedRoutes) {
  const html = readFileSync(resolve("out", route), "utf8");
  const initialMarkup = html.split("<script>(self.__next_f")[0];

  assert.doesNotMatch(initialMarkup, /<main|class="app-shell"|route-access-gate|admin-dashboard-next/);
}

console.log("Protected routes render no application content before authentication.");
