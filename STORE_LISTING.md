# GifGrab browser-store listing

## Names

- Chrome Web Store: GifGrab Collector
- Microsoft Edge Add-ons: GifGrab Collector for Edge
- Firefox Browser Add-ons: GifGrab Collector for Firefox
- Opera Add-ons: GifGrab Collector for Opera

## Short description

Collect modern web animations and send them to the local GifGrab desktop queue.

## Full description

GifGrab Collector finds modern web animations that ordinary image downloaders often miss.

Press Collect This Page to identify animated WebP, GIF, MP4, WebM, AVIF, and media linked behind detail pages. Use Load More + Collect on scrolling galleries. Your selections go to the GifGrab desktop app, where large collections stay organized in a resumable queue.

Duplicate checks compare both the page address and the resolved media source so collecting the same page again does not download the same animation twice. Optional conversion to GIF happens locally on your computer.

The free GifGrab desktop app for Mac or Windows is required. GifGrab does not bypass logins, paywalls, DRM, or access controls. Only download media you are legally allowed to save.

## Category and language

- Category: Productivity
- Language: English
- Price: Free

## Privacy and support

- Privacy policy: https://goodtools.ca/privacy/gifgrab
- Product page: https://goodtools.ca/tools/gifgrab
- Support: hello@goodtools.ca

## Single purpose

Identify animation links and media sources on the active page, then send the user-selected collection to the local GifGrab desktop queue.

## Permission explanations

- `activeTab`: accesses only the page where the user presses the GifGrab collector.
- `scripting`: scans that active page for animation cards, links, images, and video sources after a collector button is pressed.
- Website access: allows the user to invoke GifGrab on animation sites of their choice. It is not used in the background.
- `127.0.0.1`: checks for and sends the selected collection to the GifGrab desktop app on the same computer.

## Data disclosure

The extension handles the active page address, animation links, image descriptions, and media sources only after the user presses a collect button. That information is sent only to the GifGrab desktop app over a local loopback connection. Good Tools does not receive it. The extension has no analytics, advertising, accounts, telemetry, remote code, or data sales.

## Reviewer instructions

1. Install and open the matching GifGrab desktop app.
2. Visit https://goodtools.ca/tools/gifgrab/demo in the browser.
3. Open the extension and press Collect This Page.
4. Confirm that the extension reports “Added 2” and the desktop queue contains both sample animations.
5. Press Collect This Page again and confirm that it reports “Added 0,” demonstrating duplicate protection.
6. The Load More + Collect button is intended for scrolling galleries; the safe test page is deliberately finite.

