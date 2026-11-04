#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitBookAPI } from "@gitbook/api";

// Module-level, in-memory cache of each space's content (valid page paths and
// slugs), keyed by space id. Shared across `checkBrokenLinks` calls so repeated
// runs in the same process never re-fetch a space. Callers can pass their own
// `cache` in options to isolate or reset it.
const spacePagesCache = new Map();

// Module-level cache of `/git/installations/:id` responses, keyed by
// installation id, so resolving space folders never re-fetches an installation.
const gitInstallationCache = new Map();

function printUsage() {
  console.error(
    [
      "Usage: check-broken-links <inputDir> [options]",
      "",
      "  <inputDir>              A folder of spaces, or a folder of folders of spaces.",
      "",
      "Options:",
      "  --legacy-host <host>    Host that marks an unresolved legacy docs link.",
      "                          Repeatable, and accepts a comma-separated list.",
      "  --site-id <siteId>      GitBook site id. Resolves each folder to its space",
      "                          id (via Git Sync) so the report links to the space",
      "                          and page in the GitBook app.",
      "  --org-id <orgId>        Organization owning the site. Optional; discovered",
      "                          from the site id when omitted.",
      "  --output <file>         CSV output path (default: broken-links.csv).",
      "  --token <token>         GitBook API token (default: $GITBOOK_TOKEN).",
    ].join("\n"),
  );
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Discovering markdown files and the space each one belongs to.
// ---------------------------------------------------------------------------

// Walks the input tree collecting every markdown file (excluding SUMMARY.md)
// and every directory that holds a SUMMARY.md — the latter mark space roots,
// used to attribute each file to its space in the report.
async function collectFiles(rootDir) {
  const markdownFiles = [];
  const spaceRoots = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });

    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === "summary.md")) {
      spaceRoots.push(dir);
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".gitbook") continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        if (entry.name.toLowerCase() === "summary.md") continue;
        markdownFiles.push(full);
      }
    }
  }

  await walk(rootDir);
  return { markdownFiles, spaceRoots };
}

// Attributes a file to a space: the deepest space root that contains it, falling
// back to the top-level folder under the input directory.
function spaceForFile(fileAbsPath, spaceRoots, inputPath) {
  let best = null;
  for (const root of spaceRoots) {
    const rel = path.relative(root, fileAbsPath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      if (best === null || root.length > best.length) best = root;
    }
  }
  if (best) return toPosix(path.relative(inputPath, best)) || ".";

  const rel = toPosix(path.relative(inputPath, fileAbsPath));
  const segments = rel.split("/");
  return segments.length > 1 ? segments[0] : ".";
}

// ---------------------------------------------------------------------------
// Extracting links from markdown (excluding images).
// ---------------------------------------------------------------------------

function lineForIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

// Cleans a raw markdown link target: unwraps <...>, drops a trailing "title",
// and normalises backslash-escaped characters that GitBook emits in URLs.
function cleanTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  } else {
    // Drop an optional link title: `path "Title"` or `path 'Title'`.
    const titleMatch = target.match(/\s+["'].*["']$/);
    if (titleMatch) target = target.slice(0, titleMatch.index).trim();
  }
  return target.replace(/\\([&#()])/g, "$1");
}

// Extracts every link worth checking, excluding images. Covers inline markdown
// links, GitBook `{% content-ref %}` blocks, and HTML anchors.
function extractLinks(markdown) {
  const links = [];

  // Inline markdown links `[text](target)`, skipping images `![alt](src)`.
  const INLINE = /(!?)\[((?:[^\]\\]|\\.)*)\]\(\s*([^)]*?)\s*\)/g;
  for (const match of markdown.matchAll(INLINE)) {
    if (match[1] === "!") continue; // image
    const target = cleanTarget(match[3]);
    if (!target) continue;
    links.push({
      text: match[2].trim(),
      target,
      line: lineForIndex(markdown, match.index),
    });
  }

  // GitBook content references: `{% content-ref url="target" %}`.
  const CONTENT_REF = /\{%\s*content-ref\s+url=["']([^"']+)["']/g;
  for (const match of markdown.matchAll(CONTENT_REF)) {
    const target = cleanTarget(match[1]);
    if (!target) continue;
    links.push({
      text: "",
      target,
      line: lineForIndex(markdown, match.index),
    });
  }

  // HTML anchors `<a href="target">`.
  const HREF = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
  for (const match of markdown.matchAll(HREF)) {
    const target = cleanTarget(match[1]);
    if (!target) continue;
    links.push({
      text: "",
      target,
      line: lineForIndex(markdown, match.index),
    });
  }

  return links;
}

// ---------------------------------------------------------------------------
// Classifying links.
// ---------------------------------------------------------------------------

// Splits an app.gitbook.com URL into its space id and page path. Handles both
// `/s/<spaceId>/<page>` and `/o/<org>/s/<spaceId>/<page>` shapes.
function parseCrossSpaceUrl(url) {
  const segments = url.pathname.split("/").filter(Boolean);
  const sIndex = segments.indexOf("s");
  if (sIndex === -1 || sIndex + 1 >= segments.length) return null;

  const spaceId = segments[sIndex + 1];
  const pageSegments = segments.slice(sIndex + 2);
  let pagePath = pageSegments.join("/");
  try {
    pagePath = decodeURIComponent(pagePath);
  } catch {
    /* keep raw value */
  }
  // Drop a trailing `/README` — a folder page's canonical path omits it, mirroring
  // the on-disk `<page>/README.md` convention.
  pagePath = pagePath.replace(/\/+$/, "").replace(/\/readme$/i, "");
  return { spaceId, pagePath };
}

// Returns `{ kind, ... }` describing what a link is, or null to ignore it.
function classifyLink(target, legacyHosts) {
  if (target.startsWith("#")) return null; // in-page anchor

  const schemeMatch = target.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") return null; // mailto:, tel:, etc.

    let url;
    try {
      url = new URL(target);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();

    if (host === "app.gitbook.com") {
      const parsed = parseCrossSpaceUrl(url);
      if (!parsed) return null;
      return { kind: "cross-space", ...parsed };
    }
    if (legacyHosts.has(host)) {
      return { kind: "legacy", host };
    }
    return null; // some other external link — not our concern
  }

  // No scheme → relative link. Strip anchor and query for existence checks.
  const withoutAnchor = target.split("#")[0].split("?")[0];
  if (!withoutAnchor) return null; // pure anchor/query
  let decoded = withoutAnchor;
  try {
    decoded = decodeURIComponent(withoutAnchor);
  } catch {
    /* keep raw value */
  }
  return { kind: "relative", relPath: decoded };
}

// ---------------------------------------------------------------------------
// Validating links.
// ---------------------------------------------------------------------------

// Resolves a relative link and reports whether its target exists on disk.
//
// GitBook resolves relative links against the page's *URL path*, not its file
// path. Because a folder page `foo/bar` is stored as `foo/bar/README.md`, its
// links resolve one directory above where the README file physically lives. We
// therefore try both bases for a README, and for every candidate we honour the
// GitBook convention where a link `foo/bar` may live at `foo/bar.md` or
// `foo/bar/README.md`.
async function relativeTargetExists(fileAbsPath, relPath) {
  const fileDir = path.dirname(fileAbsPath);
  const isIndex = path.basename(fileAbsPath).toLowerCase() === "readme.md";
  const baseDirs = isIndex ? [fileDir, path.dirname(fileDir)] : [fileDir];

  for (const baseDir of baseDirs) {
    const resolved = path.resolve(baseDir, relPath);
    const candidates = [resolved];
    if (!/\.[a-z0-9]+$/i.test(path.basename(resolved))) {
      candidates.push(`${resolved}.md`);
      candidates.push(path.join(resolved, "README.md"));
      candidates.push(path.join(resolved, "readme.md"));
    }
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return true;
    }
  }
  return false;
}

// Loads (and caches) the set of valid page paths for a space. Returns null when
// the space itself cannot be found.
async function loadSpacePages(gitbook, spaceId, cache, logger) {
  if (cache.has(spaceId)) return cache.get(spaceId);

  let result;
  try {
    const { data } = await gitbook.spaces.listPages(spaceId, { metadata: false });
    // GitBook resolves a cross-space link either by a page's full path
    // (`getting-started/foo`) or by its trailing slug alone (`foo`), so we track
    // both to avoid flagging valid slug-only links.
    const paths = new Set();
    const slugs = new Set();
    (function walk(pages) {
      for (const page of pages ?? []) {
        if (typeof page.path === "string") paths.add(page.path.replace(/\/+$/, ""));
        if (typeof page.slug === "string") slugs.add(page.slug);
        if (Array.isArray(page.pages)) walk(page.pages);
      }
    })(data.pages);
    result = { exists: true, paths, slugs };
  } catch (err) {
    const status = err?.response?.status ?? err?.status;
    if (status === 404 || status === 403) {
      result = { exists: false, paths: null };
    } else {
      // A transient error (network, rate limit, 5xx): don't cache it, so a later
      // link to the same space gets another chance.
      logger.error(`⚠️  Failed to load space ${spaceId}: ${err.message}`);
      return { exists: false, paths: null, errored: true };
    }
  }

  cache.set(spaceId, result);
  return result;
}

// ---------------------------------------------------------------------------
// Resolving scanned folders to GitBook space ids (via a site's Git Sync).
//
// A GitBook site's spaces are each synced from a directory in the repo. By
// reading every space's Git installation `projectDirectory` we learn which
// folder in the scanned tree maps to which space id, and can then link each
// broken link to its space and page in the GitBook app.
// ---------------------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

// Fetches (and caches) a Git Sync installation. This endpoint is not in the
// typed client, so it is called directly.
async function fetchGitInstallation(token, installationId, cache, logger) {
  if (cache.has(installationId)) return cache.get(installationId);
  try {
    const res = await fetch(
      `https://api.gitbook.com/v1/git/installations/${installationId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      logger.error(
        `⚠️  Failed to load git installation ${installationId}: HTTP ${res.status}`,
      );
      return null; // don't cache — allow a retry
    }
    const data = await res.json();
    cache.set(installationId, data);
    return data;
  } catch (err) {
    logger.error(`⚠️  Failed to load git installation ${installationId}: ${err.message}`);
    return null;
  }
}

function normalizeProjectDir(projectDirectory) {
  return projectDirectory.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

// Derives a page's URL path (within its space) from its file path relative to
// the space folder, following GitBook's `README.md` folder convention.
function pageUrlPath(relWithinSpace) {
  const parts = relWithinSpace.replace(/\.md$/i, "").split("/").filter(Boolean);
  if (parts.length && parts[parts.length - 1].toLowerCase() === "readme") {
    parts.pop();
  }
  return parts.join("/");
}

// Finds the organization that owns a site by probing the sites the token can
// see. Used only when `--org-id` is not supplied.
async function resolveOrgIdForSite(gitbook, siteId, logger) {
  const orgIds = [];
  let page;
  do {
    const { data } = await gitbook.orgs.listOrganizationsForAuthenticatedUser(
      page ? { page } : {},
    );
    orgIds.push(...data.items.map((o) => o.id));
    page = data.next?.page;
  } while (page);

  logger.log(`🔎 Resolving organization for site ${siteId} (checking ${orgIds.length} org(s))...`);

  let found = null;
  let cursor = 0;
  async function worker() {
    while (found === null && cursor < orgIds.length) {
      const orgId = orgIds[cursor++];
      try {
        await gitbook.orgs.getSiteById(orgId, siteId);
        found = orgId;
      } catch {
        /* not this org */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, orgIds.length) }, worker));

  if (!found) {
    throw new Error(
      `Could not find site ${siteId} in any organization accessible to this token. Pass --org-id to specify it.`,
    );
  }
  return found;
}

// Collects every site space from a site's structure, walking through sections
// and (nested) section groups.
async function listAllSiteSpaces(gitbook, orgId, siteId) {
  const { data } = await gitbook.orgs.getSiteStructure(orgId, siteId);
  const siteSpaces = [];
  (function walk(items) {
    for (const item of items ?? []) {
      if (item.object === "site-space") {
        siteSpaces.push(item);
      } else if (item.object === "site-section") {
        walk(item.siteSpaces);
      } else if (item.object === "site-section-group") {
        walk(item.children);
      }
    }
  })(data.structure);
  return siteSpaces;
}

// Builds an index mapping each space folder (a Git Sync `projectDirectory`) to
// its space id, plus a `lookup` to resolve a scanned file to its space and page.
async function buildSpaceIndex({ gitbook, token, orgId, siteId, logger, installCache }) {
  if (!token) {
    throw new Error("A GitBook token is required to resolve space ids from a site id.");
  }
  const resolvedOrgId = orgId ?? (await resolveOrgIdForSite(gitbook, siteId, logger));

  const siteSpaces = await listAllSiteSpaces(gitbook, resolvedOrgId, siteId);
  const withGit = siteSpaces.filter((s) => s.space?.gitSync);
  logger.log(
    `🔗 Site ${siteId}: ${siteSpaces.length} space(s), ${withGit.length} with Git Sync — resolving project directories...`,
  );

  const entries = (
    await mapWithConcurrency(withGit, 6, async (siteSpace) => {
      const spaceId = siteSpace.space.id;
      let info;
      try {
        info = (await gitbook.spaces.getSpaceGitInfo(spaceId)).data;
      } catch (err) {
        logger.error(`⚠️  Failed to load git info for space ${spaceId}: ${err.message}`);
        return null;
      }
      if (!info.installationId) return null;
      const installation = await fetchGitInstallation(
        token,
        info.installationId,
        installCache,
        logger,
      );
      if (!installation?.projectDirectory) return null;
      return {
        projectDir: normalizeProjectDir(installation.projectDirectory),
        spaceId,
        title: siteSpace.space.title ?? siteSpace.title ?? spaceId,
      };
    })
  ).filter(Boolean);

  // Longest project directory first, so nested spaces match before their parent.
  entries.sort((a, b) => b.projectDir.length - a.projectDir.length);

  return {
    entries,
    lookup(relFile) {
      for (const entry of entries) {
        if (relFile === entry.projectDir || relFile.startsWith(`${entry.projectDir}/`)) {
          const within = relFile.slice(entry.projectDir.length).replace(/^\//, "");
          return {
            spaceId: entry.spaceId,
            title: entry.title,
            pagePath: pageUrlPath(within),
          };
        }
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// CSV.
// ---------------------------------------------------------------------------

function csvCell(value) {
  const str = String(value ?? "");
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// A spreadsheet HYPERLINK formula. Quotes in the label are neutralised so they
// can't break out of the formula string; csvCell handles CSV-level escaping.
function hyperlink(url, label) {
  const safeLabel = String(label ?? "").replace(/"/g, "'");
  return `=HYPERLINK("${url}","${safeLabel}")`;
}

function toCsv(rows) {
  const header = ["space", "page", "line", "category", "reason", "linkText", "target"];
  const lines = [header.join(",")];
  for (const row of rows) {
    const spaceCell = row.spaceUrl ? hyperlink(row.spaceUrl, row.space) : row.space;
    const pageCell = row.pageUrl ? hyperlink(row.pageUrl, row.page) : row.page;
    lines.push(
      [
        spaceCell,
        pageCell,
        row.line,
        row.category,
        row.reason,
        row.linkText,
        row.target,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function checkBrokenLinks(inputDir, options = {}) {
  if (!inputDir) throw new Error("inputDir is required");

  const logger = options.logger ?? console;
  const legacyHosts = new Set(
    (options.legacyHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
  );

  const inputPath = resolve(inputDir);
  if (!(await pathExists(inputPath))) {
    throw new Error(`Input folder not found: ${inputPath}`);
  }

  // A GitBook token is only needed once a cross-space link is actually seen, so
  // this is lazily enforced below rather than up front.
  const token =
    options.token ?? process.env.GITBOOK_TOKEN ?? process.env.GITBOOK_API_TOKEN;
  let gitbook = options.gitbook ?? (token ? new GitBookAPI({ authToken: token }) : null);

  const { markdownFiles, spaceRoots } = await collectFiles(inputPath);
  const spaceSummary =
    spaceRoots.length > 0
      ? `across ${spaceRoots.length} space(s)`
      : "(grouping by top-level folder)";
  logger.log(`🔎 Scanning ${markdownFiles.length} markdown file(s) ${spaceSummary}...`);

  // When a site id is given, resolve every scanned file to its GitBook space id
  // and page path (for app links). Files that can't be resolved are an error.
  let siteIndex = null;
  const fileMeta = new Map();
  if (options.siteId) {
    if (!gitbook) {
      throw new Error("A GitBook token is required when --site-id is used.");
    }
    siteIndex = await buildSpaceIndex({
      gitbook,
      token,
      orgId: options.orgId,
      siteId: options.siteId,
      logger,
      installCache: options.installCache ?? gitInstallationCache,
    });
    const unresolved = [];
    for (const fileAbsPath of markdownFiles) {
      const relFile = toPosix(path.relative(inputPath, fileAbsPath));
      const hit = siteIndex.lookup(relFile);
      if (!hit) unresolved.push(relFile);
      else fileMeta.set(fileAbsPath, hit);
    }
    if (unresolved.length > 0) {
      // Files not covered by any site space's project directory can't be linked
      // to a space; they are reported under UNKNOWN_SPACE rather than aborting.
      logger.error(
        `⚠️  Could not determine the GitBook space id for ${unresolved.length} file(s) — ` +
          `no site space's project directory covers them (reported as UNKNOWN_SPACE). ` +
          `Ensure --site-id ${options.siteId} matches this content and that the input ` +
          `folder is the repository root.\n` +
          unresolved.slice(0, 15).map((u) => `  - ${u}`).join("\n") +
          (unresolved.length > 15 ? `\n  ...and ${unresolved.length - 15} more` : ""),
      );
    }
  }

  const spaceCache = options.cache ?? spacePagesCache;
  const broken = [];
  let checkedLinks = 0;
  let warnedMissingToken = false;

  for (const fileAbsPath of markdownFiles) {
    const markdown = await readFile(fileAbsPath, "utf-8");
    const relFile = toPosix(path.relative(inputPath, fileAbsPath));

    // `space`/`page` are the CSV cell labels; the *Url fields turn them into
    // HYPERLINK cells when a site id resolved them.
    let space;
    let spaceUrl = null;
    let pageUrl = null;
    if (siteIndex) {
      const meta = fileMeta.get(fileAbsPath);
      if (meta) {
        space = meta.title;
        spaceUrl = `https://app.gitbook.com/o/${meta.spaceId}`;
        pageUrl = meta.pagePath
          ? `https://app.gitbook.com/o/${meta.spaceId}/${meta.pagePath}`
          : spaceUrl;
      } else {
        // No space could be resolved for this file — leave it unlinked.
        space = "UNKNOWN_SPACE";
      }
    } else {
      space = spaceForFile(fileAbsPath, spaceRoots, inputPath);
    }

    for (const link of extractLinks(markdown)) {
      const classified = classifyLink(link.target, legacyHosts);
      if (!classified) continue;
      checkedLinks++;

      const record = {
        space,
        spaceUrl,
        page: relFile,
        pageUrl,
        line: link.line,
        linkText: link.text,
        target: link.target,
      };

      if (classified.kind === "relative") {
        if (!(await relativeTargetExists(fileAbsPath, classified.relPath))) {
          broken.push({
            ...record,
            category: "relative",
            reason: "Referenced file does not exist",
          });
        }
      } else if (classified.kind === "legacy") {
        broken.push({
          ...record,
          category: "legacy",
          reason: `Unresolved legacy docs link (${classified.host})`,
        });
      } else if (classified.kind === "cross-space") {
        if (!gitbook) {
          if (!warnedMissingToken) {
            logger.error(
              "⚠️  Cross-space links found but no GITBOOK_TOKEN set — skipping their validation.",
            );
            warnedMissingToken = true;
          }
          continue;
        }
        const space_ = await loadSpacePages(
          gitbook,
          classified.spaceId,
          spaceCache,
          logger,
        );
        if (!space_.exists) {
          if (space_.errored) continue; // transient API error, not a broken link
          broken.push({
            ...record,
            category: "cross-space",
            reason: `Space not found (${classified.spaceId})`,
          });
        } else if (classified.pagePath) {
          const trailingSlug = classified.pagePath.split("/").pop();
          const found =
            space_.paths.has(classified.pagePath) || space_.slugs.has(trailingSlug);
          if (!found) {
            broken.push({
              ...record,
              category: "cross-space",
              reason: `Page not found in space ${classified.spaceId}: ${classified.pagePath}`,
            });
          }
        }
      }
    }
  }

  logger.log(
    `✅ Checked ${checkedLinks} link(s); found ${broken.length} broken.`,
  );

  const outputPath = resolve(options.output ?? "broken-links.csv");
  await writeFile(outputPath, toCsv(broken), "utf-8");
  logger.log(`📝 Wrote report to ${toPosix(path.relative(process.cwd(), outputPath))}`);

  return broken;
}

async function main() {
  const args = process.argv.slice(2);
  const positional = [];
  const legacyHosts = [];
  let output;
  let token;
  let siteId;
  let orgId;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--legacy-host") {
      const value = args[++i];
      if (value) legacyHosts.push(...value.split(","));
    } else if (arg === "--output" || arg === "-o") {
      output = args[++i];
    } else if (arg === "--token") {
      token = args[++i];
    } else if (arg === "--site-id") {
      siteId = args[++i];
    } else if (arg === "--org-id") {
      orgId = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }

  const [inputDir] = positional;
  if (!inputDir) {
    printUsage();
    process.exit(1);
  }

  try {
    await checkBrokenLinks(inputDir, { legacyHosts, output, token, siteId, orgId });
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

export { checkBrokenLinks };
