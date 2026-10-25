BEKKESTUA ANDROID WEB APP

This is an installable web app (PWA), not an APK. It has not been hosted or installed for you.

PUBLISH
1. Extract this ZIP. index.html, styles.css, app.js, sw.js and manifest.webmanifest must be at the top level of the folder you upload.
2. Visit https://app.netlify.com/drop in a browser. A computer is usually easiest for folder uploads. The service may also accept the ZIP.
3. Upload the site folder (or ZIP). Sign in/create an account to retain control of the site.
4. Open the HTTPS address provided by Netlify on your Android phone in Chrome.

INSTALL
Use the in-page Install app button when it appears, or Chrome's three-dot menu > Add to home screen > Install (wording may vary).
If only a shortcut is offered, let the page finish loading, refresh once, and check again. A local file:// page is not the deployment target.

USING THE APP
- Live Entur departures and Open-Meteo forecasts require internet access.
- The service worker caches app files, not transport/weather API responses.
- On an offline launch, the shell can open after a successful online visit; live departures remain unavailable.
- Chart.js is loaded from a pinned CDN URL and cached on a best-effort basis.
- No background push notifications or reliable background countdown execution are included. LEAVE NOW glow runs while the app is visible.
- Returning to the app triggers a fresh data request. Departures older than 2 minutes are hidden; offline departures are hidden immediately.
- The assistant remains a visual placeholder.
- The deployed site is public unless you add access controls. It contains your selected stop/routes, but no secret API keys.

STYLE
Your 24px page padding, 14px panel padding/gaps, 100px desktop clock, 25px date, ticket fonts, 62px footer, chart, and route choices are preserved. Very narrow screens use an 86px clock to reduce overflow. The reversed original clamp(100px, 5.5vw, 78px) was made explicit as 100px.
The red glow snippet is included. Files are separated into HTML, CSS, and JavaScript for editing.

UPDATES
Edit the files, then upload to the existing site's deployment area rather than making a new site. Bump CACHE in sw.js for releases where you want to replace the offline shell cache.

TEST STATUS
Package structure and JavaScript syntax are checked during creation. Real-device installation, hosting, API network responses and visual rendering have not been tested here.
