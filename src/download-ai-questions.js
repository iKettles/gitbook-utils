#!/usr/bin/env node

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitBookAPI } from "@gitbook/api";

const PAGE_LIMIT = 100;

function printUsage() {
  console.error(
    "Usage: download-ai-questions <organizationId> <siteId> [outputFile]",
  );
}

// CSV columns, in order, derived from each site-question's shape.
const CSV_COLUMNS = [
  ["id", (q) => q.id],
  ["question", (q) => q.question],
  ["type", (q) => q.type],
  ["askedAt", (q) => q.askedAt],
  ["createdAt", (q) => q.createdAt],
  ["timesAsked", (q) => q.stats?.total],
  ["answersCount", (q) => q.stats?.answers],
  ["answeredYes", (q) => q.stats?.answered?.yes],
  ["answeredPartially", (q) => q.stats?.answered?.partially],
  ["answeredNo", (q) => q.stats?.answered?.no],
  ["feedbackPositive", (q) => q.stats?.feedback?.positive],
  ["feedbackNegative", (q) => q.stats?.feedback?.negative],
  ["feedbackUnrated", (q) => q.stats?.feedback?.unrated],
  ["relevanceRelevant", (q) => q.stats?.relevance?.relevant],
  ["relevanceSpam", (q) => q.stats?.relevance?.spam],
  ["relevanceOffTopic", (q) => q.stats?.relevance?.["off-topic"]],
  ["relevanceUnclear", (q) => q.stats?.relevance?.unclear],
  ["visitorHuman", (q) => q.stats?.visitorTypes?.human],
  ["visitorAgent", (q) => q.stats?.visitorTypes?.agent],
  ["visitorBot", (q) => q.stats?.visitorTypes?.bot],
  ["visitorUnknown", (q) => q.stats?.visitorTypes?.unknown],
];

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(questions) {
  const header = CSV_COLUMNS.map(([name]) => csvEscape(name)).join(",");
  const rows = questions.map((q) =>
    CSV_COLUMNS.map(([, get]) => csvEscape(get(q))).join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

async function fetchAllQuestions(organizationId, siteId, options = {}) {
  const token =
    options.token ?? process.env.GITBOOK_TOKEN ?? process.env.GITBOOK_API_TOKEN;
  if (!token) {
    throw new Error("Missing GITBOOK_TOKEN or GITBOOK_API_TOKEN env var");
  }

  const gitbook = options.gitbook ?? new GitBookAPI({ authToken: token });
  const logger = options.logger ?? console;

  const questions = [];
  let page = undefined;

  do {
    const { data } = await gitbook.orgs.listSiteQuestions(
      organizationId,
      siteId,
      {
        limit: options.limit ?? PAGE_LIMIT,
        ...(page ? { page } : {}),
      },
    );

    const items = data.items ?? [];
    questions.push(...items);
    logger.log(`📥 Fetched ${questions.length} question(s) so far...`);

    page = data.next?.page;
  } while (page);

  return questions;
}

async function downloadAiQuestions(
  organizationId,
  siteId,
  outputFile,
  options = {},
) {
  if (!organizationId || !siteId) {
    throw new Error("organizationId and siteId are required");
  }

  const logger = options.logger ?? console;

  // Timestamp marking when these questions were fetched from the API.
  const fetchedAt = new Date().toISOString();
  logger.log(`🕒 Fetching AI assistant questions as of ${fetchedAt}`);

  const questions = await fetchAllQuestions(organizationId, siteId, options);

  const outputPath = resolve(
    outputFile ?? `ai-questions-${fetchedAt.replace(/[:.]/g, "-")}.csv`,
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, toCsv(questions), "utf-8");

  logger.log(
    `✅ Wrote ${questions.length} question(s) to ${outputPath}`,
  );
  logger.log(`🕒 Fetched from the GitBook API at ${fetchedAt}`);

  return { outputPath, fetchedAt, count: questions.length };
}

async function main() {
  const args = process.argv.slice(2);
  const [organizationId, siteId, outputFile] = args;

  if (!organizationId || !siteId) {
    printUsage();
    process.exit(1);
  }

  try {
    await downloadAiQuestions(organizationId, siteId, outputFile);
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

export { downloadAiQuestions, fetchAllQuestions };
