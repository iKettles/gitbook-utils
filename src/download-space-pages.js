#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitBookAPI } from "@gitbook/api";

function printUsage() {
  console.error("Usage: download-space-pages <spaceId> <outputDir>");
}

function walkPages(pages, onPage) {
  for (const page of pages ?? []) {
    onPage(page);
    if (Array.isArray(page.pages) && page.pages.length > 0) {
      walkPages(page.pages, onPage);
    }
  }
}

async function downloadSpacePages(spaceId, outputDir, options = {}) {
  if (!spaceId || !outputDir) {
    throw new Error("spaceId and outputDir are required");
  }

  const token =
    options.token ?? process.env.GITBOOK_TOKEN ?? process.env.GITBOOK_API_TOKEN;
  if (!token) {
    throw new Error("Missing GITBOOK_TOKEN or GITBOOK_API_TOKEN env var");
  }

  const outputPath = resolve(outputDir);
  await mkdir(outputPath, { recursive: true });

  const gitbook = options.gitbook ?? new GitBookAPI({ authToken: token });
  const logger = options.logger ?? console;

  const latestRevision = await gitbook.spaces.listPages(spaceId, {
    metadata: false,
  });
  const revision = latestRevision.data;

  const pages = [];
  walkPages(revision.pages, (page) => pages.push(page));
  logger.log(
    `🔎 Found ${pages.length} pages in space ${spaceId}, fetching each page and writing to disk...`,
  );

  for (const page of pages) {
    logger.log(`📄 Page ID: ${page.id}, Title: ${page.title}`);

    const { data: pageResponse } = await gitbook.spaces.getPageById(
      spaceId,
      page.id,
      {
        format: "markdown",
        computed: true,
      },
    );

    if (pageResponse.computed?.type === "builtin:openapi") {
      logger.log(`⏩  Skipping OpenAPI page.`);
      continue;
    }

    if (pageResponse.type === "group") {
      logger.log(`⏩  Skipping group page.`);
      continue;
    }

    let pageFilePath = pageResponse.path;

    // Ensure all readme.md files end up with README.md — this reflects the underlying storage (these paths can get lowercased when returned from the API)
    if (path.basename(pageFilePath) === "readme.md") {
      pageFilePath = path.join(path.dirname(pageFilePath), "README.md");
    }

    if ((pageResponse.pages ?? []).length > 0) {
      pageFilePath = path.join(pageFilePath, "README");
    }

    let markdown = pageResponse.markdown;

    // Write variables to frontmatter
    if (pageResponse.variables) {
      const frontmatterLines = ["---", "vars:"];
      for (const [key, value] of Object.entries(pageResponse.variables)) {
        frontmatterLines.push(` ${key}: ${value}`);
      }
      frontmatterLines.push("---");
      markdown = frontmatterLines.join("\n") + "\n\n" + markdown;
    }

    const filePath = path.join(outputPath, `${pageFilePath}.md`);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf-8");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [spaceId, outputDir] = args;

  if (!spaceId || !outputDir) {
    printUsage();
    process.exit(1);
  }

  try {
    await downloadSpacePages(spaceId, outputDir);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { downloadSpacePages };
