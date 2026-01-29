#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolve } from "node:path";
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

async function main() {
  const args = process.argv.slice(2);
  const [spaceId, outputDir] = args;

  if (!spaceId || !outputDir) {
    printUsage();
    process.exit(1);
  }

  const token = process.env.GITBOOK_TOKEN;
  if (!token) {
    console.error("Missing GITBOOK_TOKEN env var");
    process.exit(1);
  }

  const outputPath = resolve(outputDir);
  await mkdir(outputPath, { recursive: true });

  const gitbook = new GitBookAPI({ authToken: token });

  const latestRevision = await gitbook.spaces.listPages(spaceId, {
    metadata: false,
  });
  const revision = latestRevision.data;

  const pages = [];
  walkPages(revision.pages, (page) => pages.push(page));
  console.log(
    `🔎 Found ${pages.length} pages in space ${spaceId}, fetching each page and writing to disk...`,
  );

  for (const page of pages) {
    console.log(`📄 Page ID: ${page.id}, Title: ${page.title}`);

    const { data: pageResponse } = await gitbook.spaces.getPageById(
      spaceId,
      page.id,
      {
        format: "markdown",
        computed: true,
      },
    );

    if (pageResponse.computed?.type === "builtin:openapi") {
      console.log(`⏩  Skipping OpenAPI page.`);
      continue;
    }

    if (pageResponse.type === "group") {
      console.log(`⏩  Skipping group page.`);
      continue;
    }

    let pageFilePath = pageResponse.path;

    // Ensure all readme.md files end up with README.md — this reflects the underlying storage (these paths can get lowercased when returned from the API)
    if (path.basename(pageFilePath) === "readme.md") {
      pageFilePath = path.join(path.dirname(pageFilePath), "README.md");
    }

    if (pageResponse.pages.length > 0) {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
