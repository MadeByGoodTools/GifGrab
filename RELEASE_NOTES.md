# GifGrab 0.3.5 + Collector 0.3.3

The collector now counts GIF cards on sex.com once instead of also adding their preview images and page icons. **Load More + Collect** keeps discoveries from earlier scroll positions even when the site replaces its visible cards. The popup shows the real number found and displays collection errors.

The desktop app now waits longer before retrying temporary server failures such as HTTP 429. A site can still limit requests; if that happens, wait and retry the failed items later.

## GifGrab 0.3.4

The desktop app now opens with a fresh download list each time. It no longer saves queue or download history; existing files remain in place and duplicate checks still apply during a session and against matching files in the selected folder.

Choose a different download folder with **Browse…**, or type a full path into **Save to**. GifGrab remembers only that folder preference. New downloads use the new folder; existing files are not moved. Folder changes are paused while a batch is queued or running.

The browser collectors are unchanged in this release.

## GifGrab Collector 0.3.2

Adds a clear **Get the GifGrab desktop app** link to every browser Collector popup. The link opens the official Good Tools GifGrab page, where Mac and Windows downloads are available.

The desktop app remains version 0.3.1.

## GifGrab 0.3.1

First public beta of GifGrab, a local Mac and Windows batch animation downloader with Chrome, Edge, Firefox, and Opera collectors.

GifGrab detects animated WebP, GIF, MP4, WebM, AVIF, and media hidden behind detail pages. It keeps a resumable queue, avoids duplicate downloads, and can convert compatible files to GIF locally.

Only download media you are legally allowed to save. GifGrab does not bypass logins, paywalls, DRM, or access controls.
