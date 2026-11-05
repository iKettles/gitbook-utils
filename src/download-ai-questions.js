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

// CSV columns, in order, derived from each site-question-answer's shape.
// Each answer is one individual submission (the raw question a visitor asked,
// the resolved/canonical phrasing, and that submission's metadata), so the
// export has one row per question ever submitted rather than one row per
// deduplicated canonical question.
const CSV_COLUMNS = [
  ["id", (a) => a.id],
  ["questionId", (a) => a.question?.id],
  ["questionType", (a) => a.question?.type],
  ["question", (a) => a.input?.text],
  ["rawInput", (a) => a.input?.raw],
  ["createdAt", (a) => a.createdAt],
  ["answered", (a) => a.answered],
  ["relevance", (a) => a.relevance],
  ["helpfulness", (a) => a.helpfulness],
  ["language", (a) => a.language],
  ["channelType", (a) => a.channel?.type],
  ["visitorType", (a) => a.visitorType],
  ["topics", (a) => (a.topics ?? []).join(";")],
  ["threadId", (a) => a.thread?.id],
  ["url", (a) => a.urls?.location],
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

function toCsv(answers) {
  const header = CSV_COLUMNS.map(([name]) => csvEscape(name)).join(",");
  const rows = answers.map((a) =>
    CSV_COLUMNS.map(([, get]) => csvEscape(get(a))).join(","),
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

  // Each "answer" is one individual question submission, so listing answers
  // (rather than the deduplicated canonical questions) yields every question
  // that has ever been submitted.
  const answers = [];
  let page = undefined;

  do {
    const { data } = await gitbook.orgs.listSiteQuestionAnswers(
      organizationId,
      siteId,
      {
        limit: options.limit ?? PAGE_LIMIT,
        ...(page ? { page } : {}),
      },
    );

    const items = data.items ?? [];
    answers.push(...items);
    logger.log(`📥 Fetched ${answers.length} question(s) so far...`);

    page = data.next?.page;
  } while (page);

  return answers;
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
