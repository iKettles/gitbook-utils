#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function printUsage() {
  console.error(
    "Usage: merge-spaces <spaceDir1> <spaceDir2> [...spaceDirN] <outputDir>",
  );
}

function slugify(value) {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "space"
  );
}

// Matches an asset reference of the form `.gitbook/assets/<path>`, consuming any
// leading relative prefix (`/`, `./`, `../`, repeated). Captures the path that
// follows so it can be looked up in the per-space asset map.
const ASSET_REFERENCE = /(?:\.{0,2}\/)*\.gitbook\/assets\/([^\s"')>\]?#]+)/g;

async function walkFiles(rootDir, relativeDir = "") {
  const files = [];
  const entries = await readdir(path.join(rootDir, relativeDir), {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      // .git and .gitbook are handled separately (or ignored)
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
    return await walkFiles(assetsDir);
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

// Rewrites `.gitbook/assets/...` references in a markdown file so they point at
// the merged assets directory, using freshly computed relative paths (the file
// is now one level deeper, under the space folder) and the resolved final asset
// names.
function rewriteAssetReferences(markdown, { outputFilePath, outputDir, assetMap }) {
  const outputFileDir = path.dirname(outputFilePath);

  return markdown.replace(ASSET_REFERENCE, (match, capturedPath) => {
    let assetKey = capturedPath;
    try {
      assetKey = decodeURIComponent(capturedPath);
    } catch {
      // leave the raw value if it is not valid percent-encoding
    }

    const finalName = assetMap.get(assetKey) ?? assetMap.get(capturedPath);
    if (!finalName) {
      // Not one of the merged assets (e.g. a stale/missing reference); leave it.
      return match;
    }

    const targetPath = path.join(outputDir, ".gitbook", "assets", finalName);
    let relativePath = path
      .relative(outputFileDir, targetPath)
      .split(path.sep)
      .join("/");
    if (!relativePath.startsWith(".")) {
      relativePath = `./${relativePath}`;
    }

    // Preserve spaces via percent-encoding, matching how GitBook references them.
    return relativePath.replace(/ /g, "%20");
  });
}

function rewriteSummaryTarget(target, slug) {
  const trimmed = target.trim();

  // Leave external links, anchors, and mail links untouched.
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(trimmed)) {
    return target;
  }

  return `${slug}/${trimmed}`.replace(/\/{2,}/g, "/");
}

// Extracts the list items from a space's SUMMARY.md, dropping the internal group
// headings (each source space becomes a single top-level group in the merged
// SUMMARY). Page nesting is preserved via the original list indentation, and
// every link target is prefixed with the space folder.
function extractSummaryItems(summary, slug, logger) {
  const lines = summary.split(/\r?\n/);
  const items = [];
  let droppedGroups = 0;

  for (const line of lines) {
    if (/^\s*#{2,}\s/.test(line)) {
      droppedGroups += 1;
      continue;
    }

    const listMatch = line.match(/^(\s*)([*-])\s+(.*)$/);
    if (!listMatch) {
      continue;
    }

    const [, indent, bullet, content] = listMatch;
    const rewritten = content.replace(
      /\]\(([^)]+)\)/,
      (match, target) => `](${rewriteSummaryTarget(target, slug)})`,
    );
    items.push(`${indent}${bullet} ${rewritten}`);
  }

  if (droppedGroups > 0) {
    logger.log(
      `ℹ️  Flattened ${droppedGroups} internal group heading(s) from "${slug}" into the top-level group.`,
    );
  }

  return items;
}

async function readSummaryItems(spaceDir, slug, mdFiles, logger) {
  try {
    const summary = await readFile(
      path.join(spaceDir, "SUMMARY.md"),
      "utf-8",
    );
    const items = extractSummaryItems(summary, slug, logger);
    if (items.length > 0) {
      return items;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  // Fallback: no usable SUMMARY.md, list the markdown files (README first).
  logger.log(
    `ℹ️  No usable SUMMARY.md for "${slug}", generating a flat page list.`,
  );
  const sorted = [...mdFiles].sort((a, b) => {
    const aReadme = path.basename(a).toLowerCase() === "readme.md";
    const bReadme = path.basename(b).toLowerCase() === "readme.md";
    if (aReadme !== bReadme) return aReadme ? -1 : 1;
    return a.localeCompare(b);
  });

  return sorted.map((relativePath) => {
    const posixPath = relativePath.split(path.sep).join("/");
    const title = path
      .basename(relativePath, ".md")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return `* [${title}](${slug}/${posixPath})`;
  });
}

async function mergeSpaces(spaceDirs, outputDir, options = {}) {
  if (!Array.isArray(spaceDirs) || spaceDirs.length < 2) {
    throw new Error("At least two space folders are required");
  }
  if (!outputDir) {
    throw new Error("outputDir is required");
  }

  const logger = options.logger ?? console;
  const outputPath = resolve(outputDir);
  await mkdir(path.join(outputPath, ".gitbook", "assets"), {
    recursive: true,
  });

  // Resolve each space to a unique slug/group name.
  const usedSlugs = new Set();
  const spaces = spaceDirs.map((dir, index) => {
    const resolved = resolve(dir);
    const name = options.names?.[index] ?? path.basename(resolved);
    let slug = slugify(name);
    let candidate = slug;
    let counter = 2;
    while (usedSlugs.has(candidate)) {
      candidate = `${slug}-${counter++}`;
    }
    slug = candidate;
    usedSlugs.add(slug);
    return { dir: resolved, name, slug };
  });

  // First pass: collect every asset and detect duplicate names across spaces.
  const assetCounts = new Map();
  for (const space of spaces) {
    space.assets = await listAssets(space.dir);
    for (const relativePath of space.assets) {
      const posixPath = relativePath.split(path.sep).join("/");
      assetCounts.set(posixPath, (assetCounts.get(posixPath) ?? 0) + 1);
    }
  }

  // Build per-space asset maps (original path -> final name) and copy assets.
  const usedAssetNames = new Set();
  for (const space of spaces) {
    space.assetMap = new Map();
    for (const relativePath of space.assets) {
      const posixPath = relativePath.split(path.sep).join("/");
      const dir = path.posix.dirname(posixPath);
      const base = path.posix.basename(posixPath);

      let finalBase = base;
      if ((assetCounts.get(posixPath) ?? 0) > 1) {
        finalBase = `${space.slug}-${base}`;
      }
      let finalPath = dir === "." ? finalBase : path.posix.join(dir, finalBase);

      // Guard against an unlikely collision with an already-claimed name.
      let counter = 2;
      while (usedAssetNames.has(finalPath)) {
        const guarded = `${space.slug}-${counter++}-${base}`;
        finalPath = dir === "." ? guarded : path.posix.join(dir, guarded);
      }
      usedAssetNames.add(finalPath);
      space.assetMap.set(posixPath, finalPath);

      const source = path.join(space.dir, ".gitbook", "assets", relativePath);
      const destination = path.join(
        outputPath,
        ".gitbook",
        "assets",
        finalPath,
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    logger.log(
      `🖼️  Copied ${space.assets.length} asset(s) from "${space.name}".`,
    );
  }

  // Second pass: copy pages into <slug>/, rewriting asset references.
  const summarySections = [];
  for (const space of spaces) {
    const files = await walkFiles(space.dir);
    const pageFiles = files.filter((relativePath) => relativePath !== "SUMMARY.md");
    const mdFiles = [];

    for (const relativePath of pageFiles) {
      const source = path.join(space.dir, relativePath);
      const destination = path.join(outputPath, space.slug, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });

      if (relativePath.toLowerCase().endsWith(".md")) {
        mdFiles.push(relativePath);
        const markdown = await readFile(source, "utf-8");
        const rewritten = rewriteAssetReferences(markdown, {
          outputFilePath: destination,
          outputDir: outputPath,
          assetMap: space.assetMap,
        });
        await writeFile(destination, rewritten, "utf-8");
      } else {
        await copyFile(source, destination);
      }
    }

    const items = await readSummaryItems(space.dir, space.slug, mdFiles, logger);
    summarySections.push({ name: space.name, items });
    logger.log(
      `📄 Merged ${pageFiles.length} file(s) from "${space.name}" into "${space.slug}/".`,
    );
  }

  // Write a minimal root README (the merged space needs a root page).
  const rootReadme = [
    "# Merged space",
    "",
    "This space was merged from the following spaces:",
    "",
    ...spaces.map((space) => `- ${space.name}`),
    "",
  ].join("\n");
  await writeFile(path.join(outputPath, "README.md"), rootReadme, "utf-8");

  // Write the combined SUMMARY.md, one top-level group per source space.
  const summaryLines = ["# Table of contents", "", "* [Introduction](README.md)", ""];
  for (const section of summarySections) {
    summaryLines.push(`## ${section.name}`, "");
    summaryLines.push(...section.items, "");
  }
  await writeFile(
    path.join(outputPath, "SUMMARY.md"),
    summaryLines.join("\n"),
    "utf-8",
  );

  logger.log(
    `✅ Merged ${spaces.length} space(s) into ${outputPath}`,
  );
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    printUsage();
    process.exit(1);
  }

  const outputDir = args[args.length - 1];
  const spaceDirs = args.slice(0, -1);

  try {
    await mergeSpaces(spaceDirs, outputDir);
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

export { mergeSpaces };
