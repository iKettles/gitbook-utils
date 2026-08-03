# gitbook-utils

A set of utilities to make frequent tasks with the GitBook API easier.

## Prerequisites

- `GITBOOK_TOKEN` environment variable

## download-space-pages

- Downloads pages from a space to markdown files reflecting the same hierarchy as set in GitBook.
- Each page is computed, meaning Reusable Content blocks are resolved to their static content.
- OpenAPI pages are currently skipped.
- Page variables set in GitBook will be automatically added to the frontmatter of the generated markdown file.
- Can be used as a CLI or imported as `downloadSpacePages(spaceId, outputDir, options)`.

Usage:

`./src/download-space-pages.js $SPACE_ID $OUTPUT_DIR`

## move-space-content

- Moves all of one GitBook space folder's content into another space folder, nested under a new page.
- The 3rd argument is the name of the page the content is created under; it becomes a folder (`<page>/README.md`) in the destination, with the source content beneath it.
- The source tree is reorganised to follow GitBook's folder convention: pages with children live at `<page>/README.md`, leaf pages at `<page>.md`. The source homepage (`README.md`) is renamed to a child page, since that slot becomes the new parent page.
- All assets are moved into the destination's `.gitbook/assets`. Source asset names that collide with existing destination assets are prepended with the source space name.
- Asset references and internal page links in the moved pages are rewritten so they keep resolving after the move.
- Internal group headings in the source `SUMMARY.md` are flattened; page nesting is preserved.
- The destination `SUMMARY.md` is updated, adding the new page (with the moved subtree) as a top-level page. The source folder is left untouched.
- Can be used as a CLI or imported as `moveSpaceContent(sourceDir, destDir, pageName, options)`.

Usage:

`./src/move-space-content.js $SOURCE_SPACE_DIR $DEST_SPACE_DIR "$PAGE_NAME"`

## merge-spaces

- Merges multiple GitBook space folders into a single space folder.
- Each source space becomes a top-level group in the merged `SUMMARY.md`, with its pages moved under a folder named after the space.
- All assets are consolidated into `.gitbook/assets`. When an asset name is duplicated across spaces, every colliding copy is prepended with its space name (e.g. `logo.png` → `spacea-logo.png`).
- Asset references in the merged pages are rewritten to point at the consolidated (and possibly renamed) assets.
- Internal group headings within a source space are flattened into its top-level group; page nesting is preserved.
- A minimal root `README.md` is generated as the merged space's root page.
- Can be used as a CLI or imported as `mergeSpaces(spaceDirs, outputDir, options)`.

Usage:

`./src/merge-spaces.js $SPACE_DIR_1 $SPACE_DIR_2 [...$SPACE_DIR_N] $OUTPUT_DIR`