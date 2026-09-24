# GifGrab 0.3.8

The desktop app now shows the actual animation count rather than the raw count of GIF cards plus page previews sent by older collectors. Stalled GIF conversions time out after 3 minutes without output (or 20 minutes total), mark only that item failed, and let the rest of the queue continue. Failed items can be retried. The browser collectors are unchanged.

## GifGrab 0.3.7

Each collection now gets its own timestamped folder, with `Originals` and `GIFs` inside it. The app shows separate selected, queued, saved, converted, failed, and duplicate counts for each scan, so completed items no longer vanish from the visible totals. It also ignores duplicate page previews sent by older Firefox collectors alongside GIF cards. A new scan no longer silently skips items that appeared in an earlier scan during the same app session. GIF conversions run one at a time to reduce memory pressure on large batches. The browser collectors are unchanged.

## GifGrab 0.3.6

The desktop app now recreates missing `Originals` and `GIFs` subfolders before saving. If the selected save location is unavailable, queued downloads pause with a clear message instead of failing in bulk. You can choose another folder while the queue is paused. This update does not change the browser collectors.

## GifGrab 0.3.5 + Collector 0.3.3

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
