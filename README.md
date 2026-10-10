# JobDesk 2000

A job search tracker that looks like a Y2K desktop. Vacancies, statuses, dates, notes and stats live in
draggable windows; a customizable fairy assistant cheers you on and writes cover letters from your CV
(Gemini, with Groq as the fallback). The interface is in Ukrainian. Live site: https://jobdeck2000.netlify.app/

The front end is plain ES modules served as they are: no framework, no build step, no dependencies.
Two Netlify functions do the AI work. Guests keep everything in the browser; signed-in users
(Firebase Auth) also get a copy in Firestore.

## What it does

- Vacancies by link, pasted text or by hand; the AI fills in company, title, salary and format.
  Search (the `/` key), filters, priorities, deadline badges and a reminder from the fairy three days ahead.
  A deadline still ahead can be saved as a calendar event (an `.ics` file with a reminder at 9:00 the day before).
- Statuses with dates and notes; statistics with a funnel (applied, interviews, offers) and the last 8 weeks.
- Cover letters from the CV (PDF or pasted text) in a chat that rewrites them on request (signed-in users).
- A desktop of draggable, minimisable windows, tile mode, light and dark themes, a fairy to choose and colour,
  a wallpaper, README.TXT with the how-to, undo after a removal or a reset, confetti on an offer.
- START menu: a copy of the data (JSON) and its restore, the vacancies as a CSV table for Excel or Sheets.
- Works offline once visited and installs as an app (`public/sw.js`, `site.webmanifest`).
- Another site can hand a vacancy over with a link: `https://jobdeck2000.netlify.app/?add=<vacancy url>`
  opens the Vacancies window with the link filled in (one tap on «✦ Аналіз»). An installed app also takes
  links from the phone's share sheet (`share_target`: `?url=` or `?text=`).

## Repository layout

```
public/                        the site, published as is
  index.html                   all markup: desktop, windows, dialogs, start menu, taskbar
  404.html                     not-found page (loads no app JS)
  css/app.css                  all styles: theme tokens, shell, then one section per app
  assets/                      pixel icons, PWA icons, social preview, author photo, sound, self-hosted fonts
  favicon.ico, site.webmanifest, robots.txt, sitemap.xml
  js/
    main.js                    entry point: loads data, starts the shell and the apps, then Firebase
    core/dom.js                byId/qsa, html`` (escapes every value), raw, setHtml, safeUrl, todayISO, downloadFile
    core/events.js             app-wide on/emit; the event names are listed at the top
    core/storage.js            localStorage keys and safe access; reports writes to cloud sync
    data/user.js               the signed-in user as the UI sees it, gv() for gendered word forms
    data/statuses.js           status keys and their gendered labels
    data/jobs.js               the vacancy list, its storage format and every change to it
    data/profile.js            CV text and what the fairy learned about the user's profession
    data/timeline.js           dates: days to a deadline, applications per week, Ukrainian plural forms
    content/phrases.js         everything the fairy says on her own
    fairy/art.js               fairy SVGs: two types, three poses each
    fairy/store.js             the chosen fairy type, name and colours
    fairy/render.js            paints a fairy into an element with its colours
    services/api.js            calls to the Netlify functions, with the Firebase ID token
    services/auth.js           sign-up, sign-in (email or Google), sign-out
    services/firebase.js       loads the Firebase SDK on demand
    services/sync.js           mirrors the synced keys to Firestore users/<uid> (transactions, one push at a time)
    services/sync-merge.js     the three-way merge behind it, free of Firebase so it is unit-tested
    services/backup.js         the JSON copy of the data, its restore and the CSV table
    services/calendar.js       a vacancy's deadline as an iCalendar (.ics) event
    services/offline.js        registers the service worker (public/sw.js)
    services/pdf.js            PDF text extraction; pdf.js comes from the CDN on first use
    ui/windows.js              window manager and the APPS registry
    ui/icons.js                desktop icons on a grid, draggable on desktop
    ui/taskbar.js              taskbar, START menu, clock, account label
    ui/dialogs.js              modal dialogs, guest gate, first-visit welcome
    ui/clippy.js               the fairy in the corner: bubble, reactions, idle phrases
    ui/theme.js                light and dark theme
    ui/confirm.js              "are you sure?" in the app's own style
    ui/toast.js                short notices above the taskbar, with an optional action (undo)
    ui/confetti.js             the star burst on an offer (skipped under reduced motion)
    apps/vacancies.js          Vacancies window: add by link, pasted text or by hand; filters; cards
    apps/edit-vacancy.js       edit and add dialog, with an AI refill from pasted text
    apps/stats.js              Statistics window: counters and the pipeline bar
    apps/messenger.js          fairy messenger: the CV and the cover letter chat
    apps/fairy.js              My Fairy window: type, name, colours, wallpaper
    apps/auth-dialog.js        sign-in dialog and sign-out
    apps/backup.js             the START menu's copy, restore and table commands
  sw.js                        service worker: network first for the app, cache first for pinned CDN files
netlify/
  functions/analyze-vacancy.js vacancy link or text -> fields; mode "profile": CV -> role and phrases
  functions/cover-letter.js    writes and revises cover letters (signed-in users only)
  lib/http.js                  CORS, body parsing, input sanitising, rate limit
  lib/firebase-auth.js         Firebase ID token verification without the Admin SDK
  lib/llm.js                   Gemini model chain with the Groq fallback, loose JSON parsing
  lib/page.js                  SSRF-safe page fetch, HTML to text, JSON-LD JobPosting
netlify.toml                   publish dir, functions, security and cache headers
firestore.rules                Firestore security rules (each user reaches only users/<uid>)
firebase.json                  Firebase CLI config: the rules file and the local emulators
scripts/dev-server.js          local server: static files, functions, headers, AI mock, emulator switch
tests/web/                     unit tests for the browser modules (node:test)
tests/functions/               unit tests for the functions (node:test)
e2e/                           Playwright browser tests, run in Docker (see "Browser tests")
design/readme-icon/            generator and options of the README.TXT desktop icon
docker-compose.yml             app, test, netlify and firebase (emulators) services
docker/firebase/Dockerfile     Firebase Auth + Firestore emulators (Java 21, pinned firebase-tools)
```

## Run locally

Node 20 or newer. There is nothing to install.

```
npm run dev              # http://127.0.0.1:8888, real AI when a key is in .env
npm run dev:mock         # the same, but Gemini and Groq are always mocked
npm test                 # all unit tests
npm run test:web         # browser modules only
npm run test:functions   # functions only
```

What `scripts/dev-server.js` does:

- serves `public/` like Netlify: `/` -> `index.html`, a miss -> `404.html` with status 404, and the
  `[[headers]]` of `netlify.toml` (except caching: locally every response is `Cache-Control: no-cache`);
- runs `netlify/functions/<name>.js` on `/.netlify/functions/<name>` with a Netlify (Lambda-style) event.
  Function and `netlify/lib` code is loaded fresh on every call, so edits apply without a restart
  (which also means the in-memory rate limits never trigger locally);
- reads `./.env` (`KEY=VALUE` lines; variables already set in the shell win);
- mocks Gemini and Groq when neither `GEMINI_API_KEY` nor `GROQ_API_KEY` is set, or with `MOCK_AI=1`.
  The mock gives a deterministic vacancy, profile or letter (a revision is visibly marked).
  `GET /__mock?mode=ok|busy|slow|empty|truncated` switches what it does: every model busy (503 / 429),
  6 s per answer, answers without text, or answers cut at 60 % with a token-limit finish;
- `AUTH_TEST_CERTS=<file.json>` answers Google's securetoken certificate request with that file
  (`{ "<kid>": "<PEM certificate>" }`), so tokens signed with a local key pass verification.
  Without it a real sign-in works as in production (Firebase allows `localhost` by default);
- with `FIREBASE_EMULATORS=1` the functions accept tokens of the local Auth emulator (see below);
- listens on `HOST` (127.0.0.1) and `PORT` (8888).

### Sign-in and cloud sync without touching the real project

The Firebase Auth and Firestore emulators run in Docker with the rules from `firestore.rules`, under the
offline project `demo-jobdesk2000`, so test accounts and data never reach the real Firebase project:

```
docker compose --profile firebase up -d firebase   # emulators: Auth :9099, Firestore :8086, UI http://127.0.0.1:4000
FIREBASE_EMULATORS=1 npm run dev:mock              # or: FIREBASE_EMULATORS=1 docker compose --profile firebase up
```

Open `http://localhost:8888/`: with `FIREBASE_EMULATORS=1` the dev server adds a
`<meta name="jobdesk-emulators">` tag to the page, and the app then talks to the emulators (on 127.0.0.1, or on
`FIREBASE_EMULATOR_BROWSER_HOST`). Any email and password register an account; Google sign-in shows the
emulator's fake account picker. The functions accept the emulator's unsigned tokens only under `scripts/dev-server.js`
with `FIREBASE_EMULATORS=1`; production never does.

With Docker:

```
docker compose up app                               # dev server on http://localhost:8888
docker compose run --rm test                        # unit tests
docker compose --profile netlify run --rm netlify   # offline Netlify build of the functions
docker compose --profile firebase up firebase       # Firebase emulators (see above)
```

The `app` service reads `.env` when it exists and publishes the port on 127.0.0.1 only. The `netlify`
service runs a pinned `netlify-cli build --offline`, which bundles every function with esbuild into
`.netlify/functions/*.zip`; a require that does not resolve fails that step. npm's cache is kept in the
`npm-cache` volume.

## Browser tests

Playwright in Docker: the container starts its own dev server with the AI mock and uses the Firebase
emulators of the `firebase` service, so nothing touches the real project.

```
docker compose --profile e2e run --rm e2e                                   # everything, about 35 minutes
E2E_ARGS="--project=flows-desktop --reporter=line" docker compose --profile e2e run --rm e2e
E2E_WORKERS=1 E2E_ARGS="tests/attack-sync.spec.mjs --project=flows-desktop" docker compose --profile e2e run --rm e2e
```

- `tests/flows.spec.mjs`: user journeys on desktop Chromium and on an iPhone 11 (WebKit).
- `tests/layout.spec.mjs`: every screen on 17 devices, from an iPhone 11 to a 4K monitor, checked for sideways
  scrolling, overflowing or overlapping parts, small text, small touch targets and the fairy covering controls.
  Screenshots land in `e2e/test-results/screens/<device>/`.
- `tests/a11y.spec.mjs`: every screen in the light and the dark theme checked with axe-core (the checker behind
  Lighthouse's accessibility score) against WCAG 2.1 A and AA: contrast, labels, names, keyboard access.
- `tests/attack-*.spec.mjs`: edge cases by area (stored data, windows and keyboard, cloud sync with two
  devices, the AI flows, extreme content and text sizes). Each test states the correct behaviour.
- Arguments in `E2E_ARGS` are split on spaces inside the container: use `--grep word.word`, not quotes.
- The container mounts the repository: do not edit the app while a run is going.
- The AI mock's mode is per browser context (the `jd_mock` cookie, see `setMock()` in `e2e/tests/helpers.mjs`).
- `E2E_WORKERS` (default 3) and the 150 s test timeout suit Docker Desktop's small VM.

## Environment variables

Set them in Netlify (Site configuration -> Environment variables) or locally in `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | none | Google AI Studio key, the main engine |
| `GROQ_API_KEY` | none | fallback engine, used when every Gemini model failed; at least one of the two keys is required |
| `GEMINI_MODELS_FAST` | `gemini-3.5-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash` | models, in order, for vacancy and profile analysis |
| `GEMINI_MODELS_WRITE` | `gemini-3.5-flash,gemini-3.5-flash-lite,gemini-2.5-flash,gemini-2.5-flash-lite` | models, in order, for cover letters |
| `GROQ_MODELS` | `openai/gpt-oss-120b,openai/gpt-oss-20b` | Groq models, in order (Groq retired the Llama 3.x models on 2026-08-16; reasoning models get `reasoning_effort: "low"`) |
| `ALLOWED_ORIGINS` | none | extra origins allowed to call the functions, comma-separated (a second domain, for example) |
| `FIREBASE_PROJECT_ID` | `jobdesk2000` | the project whose ID tokens are accepted |

Model lists change without a code change; Netlify applies new values on the next deploy.
Always allowed as origins: the production site, its deploy previews and branch deploys
(`name--jobdeck2000.netlify.app`), `localhost` / `127.0.0.1`, and the site's main URL (Netlify's `URL`).

## Deploy on Netlify

`netlify.toml` already holds everything the build needs: `publish = "public"`,
`functions = "netlify/functions"`, `node_bundler = "esbuild"`, security headers for every path and
cache rules for `/assets`, `/js` and `/css`. In the Netlify UI:

1. Link the repository. Leave the base directory and the build command empty: there is nothing to build.
2. Add `GEMINI_API_KEY` (and preferably `GROQ_API_KEY`) under Environment variables, scoped to Functions.
3. For a custom domain: add it in Domain management, then to the Firebase authorized domains and the
   browser key's referrers (see the checklist below). Netlify's `URL` makes the primary domain an allowed
   origin automatically; any further domain goes into `ALLOWED_ORIGINS`.
4. Redeploy after changing variables.

## Data and compatibility

All user data lives in localStorage under these keys (`public/js/core/storage.js`). The names and value
formats are shared with the original single-file app and with existing cloud copies, so they must not change.

| Key | Value |
| --- | --- |
| `jobdesk2000_v1` | progress per vacancy: `{ "<company>\|<title>": { status, date, deadline, note } }` |
| `jobdesk2000_added_v1` | vacancies: `[{ prio, company, title, field, emp, loc, salary, url }]` |
| `jobdesk2000_user_v1` | `{ name, email, gender, uid }` |
| `jobdesk2000_theme` | `"light"` or `"dark"` |
| `jobdesk2000_iconpos_v2` | desktop icon positions `{ <app>: { x, y } }` |
| `jobdesk2000_fairy_v1` | `{ name, current, type1: { colours }, type2: { colours } }` |
| `jobdesk2000_cv_v1` | the CV as plain text |
| `jobdesk2000_wall_v1` | the wallpaper as a JPEG `data:` URL |
| `jobdesk2000_collapsed` | collapsed cards `{ <job id>: true }` |
| `jobdesk2000_welcomed` | `"1"` once the welcome dialog was closed |
| `jd2000_gender` | `{ <uid>: "f" \| "m" \| "n" }`, this device only |
| `jd2000_owner` | the uid whose data this device holds, this device only |
| `jd2000_sync_base` | fingerprint of the last copy this device and the cloud agreed on (hashes per key and per vacancy field) |
| `jd2000_sync_dirty` | `"1"` while local changes have not reached the cloud |
| `jd2000_wall_local` | `"1"` when the wallpaper is left out of the cloud copy for size |

- A vacancy's id is `<company>|<title>`. It keys the progress map, so renaming a vacancy moves its
  progress and collapsed state to the new id.
- The status is stored as its label in the user's grammatical gender ("Подалася", "Подався", "Подалися").
  A label of any gender reads back as the same status, and the next save writes the labels in the user's current form.
- Cloud copy: for a signed-in user every `jobdesk2000*` key is mirrored to the Firestore document
  `users/<uid>`: field `data` holds a JSON string of `{ key: raw value }`, field `updated` the write time in ms,
  always above the `updated` it replaced, so it is also the copy's version: a device ignores a copy older than
  one it already has and tells the echo of its own write by it. The `jd2000_*` keys stay on the device.
  Every write is a Firestore transaction: when another device changed the copy meanwhile, the two are merged
  against their common history (`jd2000_sync_base`), key by key and, for the vacancies, field by field.
  A rename carries the other side's edits over: this device's renames are recorded (`jd2000_renames`) until the
  cloud has them; another device's are recognised by content, for cards with a link or a note. Edits made
  offline, before the sync started or in a tab closed at once stay marked (`jd2000_sync_dirty`) until the cloud
  has them. A tab loads the vacancies again before a change when another tab saved meanwhile.
- Size: the copy is kept under 900 KB in UTF-8 bytes (Firestore's limit is 1 MiB; Cyrillic takes two bytes
  a letter). A new wallpaper is compressed to at most 600 KB; when notes push the copy past the limit, the
  wallpaper stays on its device and the copy says so (`jd2000_wall_omitted`), so other devices keep theirs.
- On sign-in vacancies created here as a guest join the account, also after a reload before the first sync
  (`jd2000_joining`). A vacancy both have is joined field by field: what the guest filled in is added, the
  account's values win where both have one, and two notes are both kept. A device that holds another account's
  data never uploads it; that account's changes that never reached its cloud copy are put aside on the device
  (`jd2000_stash`) and merged back when it signs in there again. Signing out removes the account's data from the device only when the cloud has all of
  it; signing out while Firebase cannot be reached ends the session on the next load (`jd2000_signed_out`).
- `tests/web/jobs.test.mjs` pins these formats against the original app.

## Where the texts live

Every visible text is plain Ukrainian in the source, so it can be edited without touching any logic:

- windows, dialogs, buttons, placeholders, the START menu: `public/index.html`;
- what the fairy says on her own (idle phrases, reactions to statuses, specialty phrases): `public/js/content/phrases.js`;
- messages of a particular window (added, saved, errors): the window's module in `public/js/apps/`;
- taskbar labels: `APPS` in `public/js/ui/windows.js`; guest gate texts: `GATE_TEXT` in `public/js/ui/dialogs.js`;
- status names in the three grammatical genders: `public/js/data/statuses.js`;
- server messages and the AI prompts: `netlify/functions/*.js`;
- the page title, description and social preview texts: the `<head>` of `public/index.html`.

## Adding a desktop app (a window)

1. Markup, in `public/index.html` inside `<main id="desktop">`, copying an existing window:

   ```html
   <section class="win" id="win-notes" data-app="notes" aria-labelledby="ti-notes">
     <div class="win-head"><span class="ic"></span><span class="ti" id="ti-notes"><img class="ti-icon" src="assets/icons/notes.png" alt="">Title</span>
       <span class="win-btns"><button type="button" class="ui win-btn" data-min="notes" aria-label="Згорнути">_</button><button type="button" class="ui win-btn close" data-close="notes" aria-label="Закрити">✕</button></span></div>
     <div class="win-body">...</div>
   </section>
   ```

   Plus its desktop icon in `#icons` (a 64x64 pixel PNG in `public/assets/icons/`) and, if wanted, a start
   menu item:

   ```html
   <button type="button" class="ui d-icon" data-open="notes"><span class="glyph"><img src="assets/icons/notes.png" alt="" width="64" height="64"></span><span class="lbl">Label</span></button>
   <button type="button" class="ui sm-item" role="menuitem" data-sm="notes"><img src="assets/icons/notes.png" alt="">Label</button>
   ```

   The icon gets a free grid cell and remembers its position by itself.
2. CSS, in `public/css/app.css`: the default size and position next to the other windows
   (`#win-notes{width:480px; left:240px; top:100px;}`) and the app's own rules in a section of their own.
   Phones and tile mode need nothing extra.
3. Registry, in `public/js/ui/windows.js`: `notes: { icon: "<emoji>", label: "<taskbar label>" }` in `APPS`.
   `needsAuth: true` sends guests to the sign-up gate; give it a text in `GATE_TEXT` in `ui/dialogs.js`.
   Every `APPS` entry needs its window in the markup, because tile mode walks the registry.
4. Module, `public/js/apps/notes.js`, exporting `initNotes()`: render with `` html`` `` and `setHtml`, handle
   clicks by delegation on a container that is re-rendered, refresh on open with `onOpen("notes", render)`,
   follow data with `on("jobs" | "user" | "state", ...)`. New stored data gets a key in `KEYS`
   (`core/storage.js`); a key starting with `jobdesk2000` is synced to the cloud automatically. Add it to
   `USER_DATA_KEYS` in `services/sync.js` as well, or signing out leaves it on the device.
5. Entry point: import `initNotes` in `public/js/main.js` and call it with the other apps.

## Backend

Two Netlify functions (Lambda-style handlers, CommonJS). The shared code in `netlify/lib` sits outside
`netlify/functions`, so Netlify does not deploy it as a function; esbuild bundles it into each one.

- **Auth.** Signed-in requests carry `Authorization: Bearer <Firebase ID token>`. `lib/firebase-auth.js`
  verifies it without the Admin SDK: RS256 only, the `kid` must be one of Google's securetoken certificates
  (cached for their `max-age`; an unknown `kid` causes at most one refetch a minute), `aud` and `iss` must
  name `FIREBASE_PROJECT_ID`, and `exp`, `iat`, `auth_time` are checked with 60 s of clock skew. Cover letters
  and profile analysis need a valid token (401 with `auth: true` otherwise); vacancy analysis is open to guests.
- **Server-side prompts.** The client sends typed fields, never a prompt. Language, tone and the gender rule
  come from whitelists, every field is length-capped and stripped of control characters, and user material
  goes inside `<vacancy>`, `<cv>`, `<letter>`, `<request>` tags that the system prompt declares to be data.
  So the functions cannot be used as a free chat.
- **SSRF-safe page fetch.** For vacancy links `lib/page.js` allows http(s) on ports 80 and 443 only, no
  credentials in the URL, no `localhost` / `.local` / `.internal` names. Every DNS answer is checked against
  private and reserved ranges at connect time (DNS rebinding cannot slip through), redirects are followed by
  hand (5 hops) and checked again, the body is capped at 2 MB, the whole fetch at 9 s, and only HTML, XML and
  plain text are read. Every failure gives the client one generic message.
- **JSON-LD.** When the page has a schema.org `JobPosting` (work.ua, robota.ua, djinni, LinkedIn, Indeed and
  many career pages), its title, company, salary, employment type, location and description are used instead
  of the page text. They also fill the fields the model left empty, and are returned on their own when the AI
  is unavailable.
- **Models.** `lib/llm.js` tries the Gemini models of the task's list in order, one quick try each inside the
  function's time budget (25 s for analysis, 45 s for letters), keeping 8 s for Groq, then the Groq models.
  JSON answers use Gemini's `responseSchema` (Groq: `json_object`). Thinking is kept minimal because it is slow
  and eats `maxOutputTokens`: `thinkingBudget: 0` on 2.5 Flash, `thinkingLevel: "minimal"` on 3.x Flash-Lite,
  `"low"` on other 3.x models. A letter cut by the token limit is trimmed to its last full sentence and signed.
- **Errors and limits.** A busy engine (429, 5xx, overload, timeout) answers `{ error, retry: true }` so the
  client can retry. Per warm instance: 40 vacancy analyses per 10 min per IP, 20 profile analyses and
  40 letters per hour per user. CORS allows only the origins listed above; any other origin gets 403.

## Owner checklist (outside the code)

- **Content policy**: `netlify.toml` sends a full `Content-Security-Policy-Report-Only`: it blocks nothing and
  only reports to the browser console. The E2E journeys check that the app causes no reports. After a while in
  production with no `[Report Only]` messages in the console, move its value into `Content-Security-Policy`.
  The inline theme script in `index.html` is allowed by its hash: a change to that script needs a new hash.
- **Texts to review** (left as they were, since texts were not to be changed): the «Умови» paragraph in
  «Про застосунок» says the data stays in the browser, while signed-in users now also have a cloud copy.
- **Google Analytics**: `measurementId` is in the Firebase config, but the original app never started
  Analytics, so nothing was ever collected. Decide whether it is wanted (with a consent notice) or drop the id.
- **Authorized domains**: remove the old `myjobdeck2000.netlify.app` (and `jobdesk2000.web.app` if unused) from
  Firebase Authentication -> Settings -> Authorized domains before that Netlify site is ever deleted.
- **README.TXT icon**: `design/readme-icon/out/overview.png` shows three options next to the other icons;
  the notebook (c) is in use.

- **Firestore rules**: `firestore.rules` lets each user read and write only their own document `users/<uid>`
  with the two fields the app writes, and denies everything else. The live project already refuses
  unauthenticated access (checked: anonymous read and write of `users/<id>` get 403), but whether its rules also
  stop one signed-in user from reading another's document cannot be seen from outside. Deploy the file to be sure:
  `npx firebase-tools@15.30.2 deploy --only firestore:rules --project jobdesk2000` (needs `firebase login`).

- **Firebase Authentication**: Email/Password and Google enabled under Sign-in method; under Settings ->
  Authorized domains `jobdeck2000.netlify.app`, any custom domain and `localhost` (there by default).
  Deploy previews are not authorized unless added, so Google sign-in fails on them.
- **Browser API key** (the `apiKey` in `public/js/services/firebase.js`; Google Cloud console -> APIs &
  Services -> Credentials): restrict it to HTTP referrers `https://jobdeck2000.netlify.app/*`,
  `https://jobdesk2000.firebaseapp.com/*` (the Google sign-in popup runs there), any custom domain, and
  `http://localhost:8888/*`, `http://127.0.0.1:8888/*` for local work. If you also restrict APIs, keep
  Identity Toolkit API, Token Service API and Cloud Firestore API.
- **Netlify environment variables**: `GEMINI_API_KEY` (required), `GROQ_API_KEY` (recommended),
  `ALLOWED_ORIGINS` for extra domains, all scoped to Functions; redeploy after a change.
