# Options Board (live feed)

Serves the Options Board app with its failing third-party data feed replaced by `/api/feed`,
a same-origin proxy for Nasdaq's free public quote API (delayed quotes), and faster refresh intervals.
`npm start` runs `server.js`. The app shell and bundle are loaded from the original deployment and patched at request time.
