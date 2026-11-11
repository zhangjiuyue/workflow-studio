import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = join(serverRoot, "src");

test("server source imports stay inside the independently deployed server directory", () => {
  const violations = [];

  for (const filePath of sourceFiles(sourceRoot)) {
    const source = readFileSync(filePath, "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const resolvedPath = fileURLToPath(new URL(specifier, pathToFileURL(filePath)));
      const relativePath = relative(serverRoot, resolvedPath);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        violations.push(`${relative(serverRoot, filePath)} imports outside server/: ${specifier}`);
      } else if (!existsSync(resolvedPath)) {
        violations.push(`${relative(serverRoot, filePath)} imports a missing file: ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:js|mjs)$/.test(entry.name) ? [entryPath] : [];
  });
}

function relativeImportSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s+["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}
