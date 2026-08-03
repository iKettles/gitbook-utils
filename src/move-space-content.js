#!/usr/bin/env node

import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  copyFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function printUsage() {
  console.error(
    'Usage: move-space-content <sourceSpaceDir> <destSpaceDir> "<pageName>"',
  );
}

function slugify(value) {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "page"
  );
}

function titleFromFileName(fileName) {
  return path
    .basename(fileName, ".md")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

// Matches an asset reference of the form `.gitbook/assets/<path>`, consuming any
// leading relative prefix. Captures the path that follows.
const ASSET_REFERENCE = /(?:\.{0,2}\/)*\.gitbook\/assets\/([^\s"')>\]?#]+)/g;

async function walkFiles(rootDir, relativeDir = "") {
  const files = [];
  const entries = await readdir(path.join(rootDir, relativeDir), {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === ".gitbook") {
        continue;
      }
      files.push(...(await walkFiles(rootDir, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

async function listAssets(spaceDir) {
  const assetsDir = path.join(spaceDir, ".gitbook", "assets");
  try {
    return (await walkFiles(assetsDir)).map((p) => p.split(path.sep).join("/"));
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function normalizeTarget(target) {
  // Drop an optional link-title (`path "Title"`), keep the path only.
  const pathPart = target.trim().replace(/^<|>$/g, "").split(/\s+/)[0];
  return path.posix.normalize(pathPart).replace(/^\.\//, "");
}

// Reads a page file, tolerating README.md/readme.md casing differences that the
// GitBook API sometimes introduces.
async function readSourceFile(sourceDir, relativeTarget) {
  const candidates = [relativeTarget];
  const base = path.posix.basename(relativeTarget);
  if (base.toLowerCase() === "readme.md" && base !== "README.md") {
    candidates.push(
      path.posix.join(path.posix.dirname(relativeTarget), "README.md"),
    );
  }
  for (const candidate of candidates) {
    try {
      return await readFile(path.join(sourceDir, candidate), "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Building the page tree (from SUMMARY.md, or the filesystem as a fallback).
// ---------------------------------------------------------------------------

function parseSummaryTree(summary, logger) {
  const lines = summary.split(/\r?\n/);
  const root = { children: [] };
  const stack = [{ indent: -1, node: root }];
  let droppedGroups = 0;

  for (const line of lines) {
    if (/^\s*#{2,}\s/.test(line)) {
      droppedGroups += 1;
      continue;
    }

    const match = line.match(/^(\s*)[*-]\s+\[([^\]]*)\]\(([^)]+)\)/);
    if (!match) continue;

    const [, indentRaw, title, target] = match;
    const indent = indentRaw.replace(/\t/g, "    ").length;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    const node = {
      title: title.trim(),
      originalTarget: normalizeTarget(target),
      children: [],
    };
    parent.children.push(node);
    stack.push({ indent, node });
  }

  if (droppedGroups > 0) {
    logger.log(
      `ℹ️  Flattened ${droppedGroups} group heading(s) from the source SUMMARY.md into the moved page tree.`,
    );
  }

  return root.children;
}

async function titleFromReadme(sourceDir, relativeTarget, fallback) {
  const content = await readSourceFile(sourceDir, relativeTarget);
  const heading = content?.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : fallback;
}

// Fallback when there is no SUMMARY.md: derive the tree from the folder layout,
// which already follows GitBook's folder/README.md convention.
async function buildTreeFromDisk(sourceDir, relativeDir = "") {
  const dir = path.join(sourceDir, relativeDir);
  const entries = await readdir(dir, { withFileTypes: true });
  const nodes = [];

  const readmeName = entries.find(
    (e) => e.isFile() && e.name.toLowerCase() === "readme.md",
  )?.name;

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    if (entry.isFile()) {
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (entry.name === readmeName && relativeDir !== "") continue; // folder index handled by its folder
      if (entry.name.toLowerCase() === "summary.md") continue;
      const relTarget = toPosix(path.join(relativeDir, entry.name));
      nodes.push({
        title: titleFromFileName(entry.name),
        originalTarget: relTarget,
        children: [],
      });
    } else if (entry.isDirectory()) {
      const childRel = path.join(relativeDir, entry.name);
      const childReadme = path.join(childRel, "README.md");
      if (await pathExists(path.join(sourceDir, childReadme))) {
        nodes.push({
          title: await titleFromReadme(
            sourceDir,
            toPosix(childReadme),
            titleFromFileName(entry.name),
          ),
          originalTarget: toPosix(childReadme),
          children: await buildTreeFromDisk(sourceDir, childRel),
        });
      } else {
        // Folder without an index page: lift its children up.
        nodes.push(...(await buildTreeFromDisk(sourceDir, childRel)));
      }
    }
  }

  return nodes;
}

// Assigns a canonical output path (relative to the new parent page's folder) to
// every node, following GitBook's convention: pages with children live at
// `<slug>/README.md`, leaf pages at `<slug>.md`.
function assignCanonicalPaths(nodes, parentDir = "") {
  for (const node of nodes) {
    const base = path.posix.basename(node.originalTarget);
    const dir = path.posix.dirname(node.originalTarget);

    let slug;
    if (base.toLowerCase() === "readme.md") {
      if (dir && dir !== ".") {
        slug = path.posix.basename(dir); // preserve the existing folder name
      } else {
        slug = slugify(node.title); // the source homepage — rename off README
        if (slug === "readme") slug = "overview";
      }
    } else {
      slug = base.replace(/\.md$/i, ""); // preserve the existing file name
    }

    if (node.children.length > 0) {
      node.canonical = path.posix.join(parentDir, slug, "README.md");
      assignCanonicalPaths(node.children, path.posix.join(parentDir, slug));
    } else {
      node.canonical = path.posix.join(parentDir, `${slug}.md`);
    }
  }
}

function flattenTree(nodes, acc = []) {
  for (const node of nodes) {
    acc.push(node);
    flattenTree(node.children, acc);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Content rewriting.
// ---------------------------------------------------------------------------

function rewriteAssetReferences(markdown, { outputFilePath, destDir, assetMap }) {
  const outputFileDir = path.dirname(outputFilePath);

  return markdown.replace(ASSET_REFERENCE, (match, capturedPath) => {
    let assetKey = capturedPath;
    try {
      assetKey = decodeURIComponent(capturedPath);
    } catch {
      /* keep raw value */
    }

    const finalName = assetMap.get(assetKey) ?? assetMap.get(capturedPath);
    if (!finalName) return match;

    const targetPath = path.join(destDir, ".gitbook", "assets", finalName);
    let relativePath = toPosix(path.relative(outputFileDir, targetPath));
    if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
    return relativePath.replace(/ /g, "%20");
  });
}

// Rewrites internal page links so they keep resolving after the tree has been
// reorganised (e.g. the source homepage README.md was renamed to a child page).
function rewriteInternalLinks(markdown, { originalTarget, canonical, pageMap }) {
  const originalDir = path.posix.dirname(originalTarget);
  const canonicalDir = path.posix.dirname(canonical);
  const LINK = /\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

  return markdown.replace(LINK, (match, target, titlePart = "") => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return match; // external / anchor
    if (target.includes(".gitbook/assets/")) return match; // handled elsewhere

    const [pathPart, anchor = ""] = target.split(/(#.*)$/);
    if (!pathPart) return match;

    const resolved = path.posix
      .normalize(path.posix.join(originalDir, pathPart))
      .replace(/^\.\//, "");
    const mapped = pageMap.get(resolved);
    if (!mapped) return match;

    let newPath = path.posix.relative(canonicalDir, mapped);
    if (newPath === pathPart) return match; // unchanged, leave as-authored
    if (!newPath.startsWith(".") && !newPath.includes("/")) {
      // sibling in the same directory — keep it bare, matching GitBook style
    }
    return `](${newPath}${anchor}${titlePart})`;
  });
}

// ---------------------------------------------------------------------------
// SUMMARY.md rendering / insertion.
// ---------------------------------------------------------------------------

function renderSummaryBlock(pageName, parentSlug, tree) {
  const lines = [`* [${pageName}](${parentSlug}/README.md)`];
  const render = (nodes, depth) => {
    for (const node of nodes) {
      lines.push(
        `${"  ".repeat(depth)}* [${node.title}](${parentSlug}/${node.canonical})`,
      );
      render(node.children, depth + 1);
    }
  };
  render(tree, 1);
  return lines;
}

function insertIntoSummary(summary, blockLines) {
  const lines = summary.split(/\r?\n/);
  const firstGroupIdx = lines.findIndex((l) => /^\s*##\s/.test(l));

  if (firstGroupIdx === -1) {
    // No groups: append to the end of the (root) page list.
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    return [...lines, ...blockLines, ""].join("\n");
  }

  // Insert as a top-level page just before the first group heading.
  const before = lines.slice(0, firstGroupIdx);
  while (before.length > 0 && before[before.length - 1].trim() === "") {
    before.pop();
  }
  const after = lines.slice(firstGroupIdx);
  return [...before, ...blockLines, "", ...after].join("\n");
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function moveSpaceContent(sourceDir, destDir, pageName, options = {}) {
  if (!sourceDir || !destDir || !pageName) {
    throw new Error("sourceDir, destDir and pageName are required");
  }

  const logger = options.logger ?? console;
  const sourcePath = resolve(sourceDir);
  const destPath = resolve(destDir);

  if (sourcePath === destPath) {
    throw new Error("sourceDir and destDir must be different folders");
  }
  if (!(await pathExists(destPath))) {
    throw new Error(`Destination space folder not found: ${destPath}`);
  }

  const sourceSlug = slugify(path.basename(sourcePath));

  // Resolve a unique folder for the new parent page within the destination.
  let parentSlug = slugify(pageName);
  let counter = 2;
  while (await pathExists(path.join(destPath, parentSlug))) {
    parentSlug = `${slugify(pageName)}-${counter++}`;
  }

  // Build the page tree from the source SUMMARY.md (or the filesystem).
  let tree;
  const summary = await readSourceFile(sourcePath, "SUMMARY.md");
  if (summary) {
    tree = parseSummaryTree(summary, logger);
  }
  if (!tree || tree.length === 0) {
    logger.log("ℹ️  No usable SUMMARY.md, deriving the tree from the filesystem.");
    tree = await buildTreeFromDisk(sourcePath);
  }
  assignCanonicalPaths(tree);

  const nodes = flattenTree(tree);
  const pageMap = new Map(nodes.map((n) => [n.originalTarget, n.canonical]));
  const handled = new Set(nodes.map((n) => n.originalTarget.toLowerCase()));

  // Move assets, prefixing source names that collide with existing dest assets.
  await mkdir(path.join(destPath, ".gitbook", "assets"), { recursive: true });
  const existingAssets = new Set(await listAssets(destPath));
  const sourceAssets = await listAssets(sourcePath);
  const assetMap = new Map();
  for (const relativePath of sourceAssets) {
    const dir = path.posix.dirname(relativePath);
    const base = path.posix.basename(relativePath);
    let finalPath = relativePath;
    if (existingAssets.has(relativePath)) {
      const renamed = `${sourceSlug}-${base}`;
      finalPath = dir === "." ? renamed : path.posix.join(dir, renamed);
    }
    assetMap.set(relativePath, finalPath);

    const from = path.join(sourcePath, ".gitbook", "assets", relativePath);
    const to = path.join(destPath, ".gitbook", "assets", finalPath);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  logger.log(`🖼️  Moved ${sourceAssets.length} asset(s) into .gitbook/assets.`);

  // Write the new parent page.
  const parentReadmePath = path.join(destPath, parentSlug, "README.md");
  await mkdir(path.dirname(parentReadmePath), { recursive: true });
  await writeFile(parentReadmePath, `# ${pageName}\n`, "utf-8");

  // Move every page into its canonical location under the new parent, rewriting
  // asset references and internal links.
  for (const node of nodes) {
    const markdown = await readSourceFile(sourcePath, node.originalTarget);
    if (markdown === null) {
      logger.log(`⚠️  Skipping missing source page: ${node.originalTarget}`);
      continue;
    }
    let content = rewriteInternalLinks(markdown, {
      originalTarget: node.originalTarget,
      canonical: node.canonical,
      pageMap,
    });
    const destination = path.join(destPath, parentSlug, node.canonical);
    content = rewriteAssetReferences(content, {
      outputFilePath: destination,
      destDir: destPath,
      assetMap,
    });
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf-8");
  }

  // Copy any remaining files not referenced by the tree (extra markdown or
  // other files), preserving their relative path under the new parent.
  const allFiles = await walkFiles(sourcePath);
  let extras = 0;
  for (const relativePath of allFiles) {
    const posixPath = toPosix(relativePath);
    if (posixPath.toLowerCase() === "summary.md") continue;
    if (handled.has(posixPath.toLowerCase())) continue;

    const destination = path.join(destPath, parentSlug, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    if (posixPath.toLowerCase().endsWith(".md")) {
      const markdown = await readFile(path.join(sourcePath, relativePath), "utf-8");
      const content = rewriteAssetReferences(markdown, {
        outputFilePath: destination,
        destDir: destPath,
        assetMap,
      });
      await writeFile(destination, content, "utf-8");
    } else {
      await copyFile(path.join(sourcePath, relativePath), destination);
    }
    extras += 1;
  }
  if (extras > 0) {
    logger.log(`📎 Copied ${extras} additional file(s) not listed in SUMMARY.md.`);
  }

  logger.log(
    `📄 Moved ${nodes.length} page(s) from "${path.basename(sourcePath)}" under "${pageName}" (${parentSlug}/).`,
  );

  // Update the destination SUMMARY.md.
  const blockLines = renderSummaryBlock(pageName, parentSlug, tree);
  const destSummaryPath = path.join(destPath, "SUMMARY.md");
  let destSummary = await readSourceFile(destPath, "SUMMARY.md");
  let newSummary;
  if (destSummary) {
    newSummary = insertIntoSummary(destSummary, blockLines);
  } else {
    newSummary = ["# Table of contents", "", ...blockLines, ""].join("\n");
  }
  await writeFile(destSummaryPath, newSummary, "utf-8");

  logger.log(`✅ Updated ${toPosix(path.relative(process.cwd(), destSummaryPath))}`);
  logger.log(
    `ℹ️  The source folder "${path.basename(sourcePath)}" was left untouched.`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const [sourceDir, destDir, pageName] = args;

  if (!sourceDir || !destDir || !pageName) {
    printUsage();
    process.exit(1);
  }

  try {
    await moveSpaceContent(sourceDir, destDir, pageName);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

export { moveSpaceContent };
