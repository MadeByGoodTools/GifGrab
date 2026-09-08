# GifGrab

GifGrab is a local Mac and Windows batch downloader with Chrome and Edge collectors. It has an optimized adapter for the current `sex.com/en/gifs` structure and a generic adapter for similar thumbnail-grid sites whose cards open animation detail pages.

## Install on macOS

1. Unzip the Apple Silicon package for M-series Macs, or the Intel package for older Macs. Move `GifGrab.app` to Applications and open it.
2. Install the collector from your browser’s extension store. Separate builds are available for Chrome, Edge, Firefox, and Opera; Edge uses the teal icon edition.
3. Visit a GIF listing and use **Collect This Page** or **Load More + Collect**. On other sites, GifGrab looks for media cards, direct animation links, and common detail-page media metadata.

## Install on Windows

1. Run `GifGrab-Windows-0.3.1.exe`. It is a portable app and does not require an installer.
2. Install the matching Chrome, Edge, Firefox, or Opera collector.
3. Open an animation listing and collect it from the extension.

Downloads are stored in the system Videos folder under `GifGrab/Originals` (`Movies` on macOS). Optional conversions go to the adjacent `GifGrab/GIFs` folder.

The macOS and Windows packages both include their own FFmpeg conversion engine. Python and a separate FFmpeg installation are not required.

Duplicate protection uses the canonical site item ID and the resolved CDN source URL. Re-collecting pages, changing categories, or restarting the app will not download the same animation twice. Filenames include the site item ID so different animations with identical titles cannot overwrite each other.

Only download media you are legally allowed to save. GifGrab does not bypass logins, paywalls, DRM, or access controls.

## Source builds

The desktop source is in `electron/`; the Chrome and Edge collectors are in their matching extension folders. Packaged public releases include the platform FFmpeg runtime used for local conversion. Those third-party binaries are intentionally excluded from this source repository.

Copyright © Good Tools. All rights reserved. No open-source license is granted by this repository.
