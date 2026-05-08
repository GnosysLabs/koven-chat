# Marketing site (`koven.chat`)

Static site that lives at `https://koven.chat/`.  Plain HTML/CSS/JS,
no build step — what's in this directory is exactly what ships.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | Landing page with hero, download CTAs, feature blurbs |
| `governance.html` | Long-form explainer of the consensus model |
| `privacy.html` | Privacy policy |
| `terms.html` | Terms of service |
| `assets/` | Images (hero photo, logo, OG card, app screenshot) |
| `favicon.png` | Tab icon |
| `robots.txt` / `sitemap.xml` | Search-engine wiring |

## Deploy

```sh
./bin/deploy-marketing            # rsync to the default VPS
./bin/deploy-marketing --dry-run  # preview the diff first
```

Uses rsync over SSH, defaults to `root@100.99.59.98`.  Override the
host with `KOVEN_MARKETING_HOST=user@host`.  No reload step needed —
nginx serves the directory directly, so file changes are live the
moment rsync finishes.

## Why the source lives in the repo

The site used to live only on the VPS, which made it easy to:

* Edit `index.html` over SSH and forget to copy the change anywhere.
* Have a deploy script (or a teammate, or a different agent) blow
  those edits away with a stale local copy.
* Lose context on *why* a particular block looks the way it does
  because the diff/blame trail was on the box and not in the repo.

Putting the canonical version in `marketing/` and treating the VPS
as a deploy target solves all three: edits get reviewed in PRs,
deploys are explicit, and `git blame` works.

## Download links

The hero CTA + each modal's download button carries
`data-download-platform="<key>"` (one of `mac`, `windows-x64`,
`linux-x64`).  An inline script at the bottom of `index.html` hits
the GitHub Releases API on page load and rewrites those `href`s to
the actual asset URL from the latest desktop release.

This is what fixed the "download link is 404" bug.  Tauri's
artifact filenames include the version number
(`Koven_0.1.2_x64-setup.exe`), so static `href`s went stale on
every release.  The resolver tracks `releases/latest` automatically
— no marketing-site redeploy needed when we cut a new desktop tag.

If JS is disabled or the API call fails, each link falls back to
`https://github.com/GnosysLabs/koven-chat/releases/latest` (the
release page itself), which always works.
