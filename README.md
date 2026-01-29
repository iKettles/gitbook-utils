# gitbook-utils

A set of utilities to make frequent tasks with the GitBook API easier.

## Prerequisites

- `GITBOOK_TOKEN` environment variable

## download-space-pages

- Downloads pages from a space to markdown files reflecting the same hierarchy as set in GitBook.
- Each page is computed, meaning Reusable Content blocks are resolved to their static content.
- OpenAPI pages are currently skipped.
- Page variables set in GitBook will be automatically added to the frontmatter of the generated markdown file.

Usage:

`./src/download-space-pages.js $SPACE_ID $OUTPUT_DIR`
