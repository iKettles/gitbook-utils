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

## check-broken-links

- Scans the markdown files in a folder of spaces (or a folder of folders of spaces) and reports every broken link to a CSV.
- `SUMMARY.md` files are excluded from the scan, and images (`![alt](src)`) are never treated as links.
- Extracts links from inline markdown links, GitBook `{% content-ref %}` blocks, and HTML `<a href>` anchors. In-page anchors (`#...`) and non-web schemes (`mailto:`, `tel:`, …) are ignored.
- Each link is checked and categorised:
  - **relative** — a relative link whose referenced file does not exist on disk. Resolution follows GitBook's conventions: a link `foo/bar` may resolve to `foo/bar.md` or `foo/bar/README.md`, and links from a folder page (`.../README.md`) resolve relative to the page's URL path.
  - **cross-space** — an `app.gitbook.com` link (`/s/<spaceId>/...` or `/o/<org>/s/<spaceId>/...`) whose space or referenced page cannot be found. The space's pages are fetched once via the GitBook API and matched by full path or trailing slug.
  - **legacy** — an external link whose host matches a host passed via `--legacy-host`, indicating an unresolved legacy docs link.
- External links to any other host are left untouched.
- The CSV columns are `space`, `page`, `line`, `category`, `reason`, `linkText`, `target`.
- When `--site-id` is given, each scanned folder is resolved to its GitBook space, and the `space` and `page` cells become clickable `=HYPERLINK()` formulas (readable in Excel/Google Sheets) pointing at `https://app.gitbook.com/o/<spaceId>` and `https://app.gitbook.com/o/<spaceId>/<pagePath>`. The space is resolved by reading the site's structure, then each space's Git Sync installation `projectDirectory`, and matching it to the folder path — so the input folder must be the repository root. If a scanned file can't be matched to a space, an error is logged and its rows are reported under `UNKNOWN_SPACE` (unlinked) rather than aborting the run. Without `--site-id`, `space` is the folder path (nearest ancestor with a `SUMMARY.md`, else the top-level folder) and `page` is the file path, with no links.
- `--org-id` (the organization owning the site) is optional; it is discovered from the site id when omitted, though passing it avoids probing every organization the token can see.
- Requires `GITBOOK_TOKEN` when cross-space links are present or when `--site-id` is used.
- Space content and Git Sync installations are each fetched from the API at most once and held in in-memory caches (shared across `checkBrokenLinks` calls in the same process), so repeated links — and repeated runs — never re-fetch the same space. Pass `options.cache` (a `Map`) to isolate or reset the space-content cache.
- Can be used as a CLI or imported as `checkBrokenLinks(inputDir, options)`, which returns the array of broken-link records.

Usage:

`./src/check-broken-links.js $INPUT_DIR --legacy-host $LEGACY_HOST [--site-id $SITE_ID] [--org-id $ORG_ID] [--output broken-links.csv]`

`--legacy-host` is repeatable and also accepts a comma-separated list. The report is written to `broken-links.csv` by default (override with `--output`).