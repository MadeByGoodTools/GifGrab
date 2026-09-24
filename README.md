# GifGrab

GifGrab is a local Mac and Windows batch downloader with Chrome and Edge collectors. It has an optimized adapter for the current `sex.com/en/gifs` structure and a generic adapter for similar thumbnail-grid sites whose cards open animation detail pages.

## Install on macOS

1. Open the Apple Silicon installer for M-series Macs, or the Intel installer for older Macs. Drag `GifGrab.app` to Applications and open it.
2. Install the collector from your browser’s extension store. Separate builds are available for Chrome, Edge, Firefox, and Opera; Edge uses the teal icon edition.
3. Visit a GIF listing and use **Collect This Page** or **Load More + Collect**. On other sites, GifGrab looks for media cards, direct animation links, and common detail-page media metadata.

## Install on Windows

1. Run `GoodTools-Installer-GifGrab-0.3.8-Windows-x64.exe` and follow the installation steps.
2. Install the matching Chrome, Edge, Firefox, or Opera collector.
3. Open an animation listing and collect it from the extension.

By default, each collection creates a timestamped folder inside `GifGrab` in your Videos folder (`Movies` on macOS). That scan's original files go in its `Originals` subfolder and conversions go in its `GIFs` subfolder. In the app, edit **Save to** or use **Browse…** to choose a different parent folder. Only the parent folder preference is saved between launches; the download list starts empty each time.

The macOS and Windows packages both include their own FFmpeg conversion engine. Python and a separate FFmpeg installation are not required.

If a GIF conversion stops producing output for 3 minutes, or runs for 20 minutes total, GifGrab marks that item failed and continues with the rest of the scan. You can retry failed items in the app.

Within each scan, duplicate protection uses the canonical site item ID and the resolved CDN source URL. A later scan gets its own folder and can include the same items again; GifGrab does not maintain a download-history database. Filenames include the site item ID so different animations with identical titles cannot overwrite each other. Changing the save folder does not move existing downloads.

Only download media you are legally allowed to save. GifGrab does not bypass logins, paywalls, DRM, or access controls.

## Source builds

The desktop source is in `electron/`; the Chrome and Edge collectors are in their matching extension folders. Packaged public releases include the platform FFmpeg runtime used for local conversion. Those third-party binaries are intentionally excluded from this source repository.

Copyright © Good Tools. All rights reserved. No open-source license is granted by this repository.
