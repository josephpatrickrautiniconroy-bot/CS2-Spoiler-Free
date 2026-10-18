# Spoiler-free CS2 site with automatic videos

This folder is your website plus a small "video watcher". Every 30 minutes, GitHub runs the watcher. It checks the YouTube channels you choose for new match videos, works out which match and map each one is, and adds it to the site. The site republishes itself automatically.

## What's in here

| File | What it is | Who changes it |
|---|---|---|
| `index.html` | The website | Nobody, unless you want to change the design |
| `data.json` | Your tournaments, stages, teams, text and pictures | You, through edit mode |
| `auto.json` | Videos the watcher found, plus matches and teams it created | The watcher |
| `watcher/config.json` | Which channels and tournaments the watcher looks at | You |
| `watcher/watch.mjs` | The watcher program | Nobody |
| `watcher/state.json` | The watcher's notes on which videos it has already seen | The watcher |
| `.github/workflows/watch.yml` | Tells GitHub to run the watcher every 30 minutes and publish the site | Nobody |

Your settings in `data.json` always win. The watcher only fills in gaps, so it never overwrites something you set.

---

## One-time setup (about 20 minutes)

### 1. Put the files on GitHub
1. Make a free account at github.com if you don't have one.
2. Click **+** (top right), then **New repository**. Give it a name, choose **Public**, and click **Create repository**.
3. On the new repository's page, click **uploading an existing file**. Drag in everything from this folder, including the `watcher` and `.github` folders, and click **Commit changes**.
   - The `.github` folder is hidden on a Mac. In Finder, press **Cmd + Shift + .** to show it before dragging.
   - If it still doesn't upload, click **Add file → Create new file**. Type `.github/workflows/watch.yml` as the name, paste in the contents of that file, and commit.

### 2. Turn on GitHub Pages
In your repository, go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.

### 3. Get a YouTube API key (free)
1. Go to console.cloud.google.com and sign in with a Google account.
2. Create a project. Any name works, for example "CS2 site".
3. Open **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.
4. Open **APIs & Services → Credentials → Create credentials → API key**, then copy the key.
5. Recommended: click the key, and under **API restrictions** limit it to the YouTube Data API v3.

### 4. Give the key to GitHub
In your repository, go to **Settings → Secrets and variables → Actions → New repository secret**.
- Name: `YOUTUBE_API_KEY`
- Secret: paste the key

The key stays private. It is never put on the website.

### 5. Check the channels and tournaments
These are already filled in.
- **Channels:** ESL Counter-Strike, BLAST and PGL.
- **Tournaments:** PGL Masters Bucharest 2026, IEM Beijing 2026, BLAST Rivals Hong Kong 2026 and the PGL Major Singapore 2026.

The tournaments are also set up on the site. To change any of this, open `watcher/config.json` on GitHub, click the pencil icon, edit it, then click **Commit changes**. See "Settings explained" below.

### 6. Run it
1. Go to the **Actions** tab. If GitHub asks, click to enable workflows.
2. Choose **Find new videos and publish the site**, then click **Run workflow**.
3. After a minute, **Settings → Pages** shows your site's address. From then on it runs by itself every 30 minutes.

---

## Before each tournament
1. **Add the tournament on your site.** Open your site with `?edit` at the end of the address. Click **+ Add tournament**, then give it a name, dates and stages. Matching the stage names to the organiser's (such as "Stage 1" or "Playoffs") makes things tidier.
2. **Add the teams.** In edit mode, open **Teams**. Add each team and a logo if you like. Under "Other names in video titles", add the names the organiser uses, for example `NAVI, Natus Vincere`. This step is optional, because the watcher creates teams it doesn't know. Adding them yourself gets you logos and nicer names.
3. **Publish your edits.** Click **Download data.json**. In your repository, click **Add file → Upload files**, drop in the new `data.json`, and commit. The site updates within a couple of minutes.
4. **Tell the watcher about the tournament.** Copy one of the blocks under `"tournaments"` in `watcher/config.json` and change it, for example:
   ```json
   {
     "siteTournament": "IEM Example 2027",
     "titleKeywords": ["IEM Example"],
     "channels": ["@ESLCS"],
     "stages": {
       "Group Stage": ["group stage", "group a", "group b"],
       "Playoffs": ["playoffs", "quarterfinal", "semifinal", "grand final"]
     },
     "stageDates": {
       "Group Stage": ["2027-02-01", "2027-02-03"],
       "Playoffs": ["2027-02-05", "2027-02-07"]
     },
     "bestOfByRound": { "Grand final": 5 },
     "defaultStage": "",
     "defaultBestOf": 3
   }
   ```

During the event, there's nothing to do. You can still add or fix things in edit mode any time.

## When the watcher isn't sure
Sometimes the watcher can't tell where a video belongs. This happens when a team name isn't recognised, the title has no map number, or the stage isn't clear. Instead of guessing, it lists the video in an issue called **"Videos that need a quick look"** on the **Issues** tab. Each item says why it was held back. Usually you fix it by adding a team's other name in **Teams**, or a keyword in `config.json`, and the next run places it.

Video titles in that issue are tucked behind "Show title" because they can contain scores. To get an email when the issue changes, click **Watch** on your repository.

To skip a video for good, add its ID to `"ignoreVideos"`.

---

## Settings explained (`watcher/config.json`)

| Setting | What it does |
|---|---|
| `channels` | YouTube channels to check. Use the handle from the channel's address, e.g. `"@SomeChannel"`, or its ID starting with `UC`. |
| `tournaments` | One block per tournament you're covering (see above). |
| `siteTournament` | The tournament's name exactly as it appears on your site. |
| `titleKeywords` | Words that appear in this tournament's video titles. A video needs at least one to count. |
| `channels` (inside a tournament) | Only look for this tournament on these channels. Leave as `[]` to use all channels. |
| `stages` | Stage name on your site → words in titles that mean that stage. |
| `stageDates` | The first and last day of each stage. When a title doesn't name its stage, the watcher uses the stage that was on when the video came out. |
| `bestOfByRound` | Series length for particular rounds, e.g. a best-of-5 grand final. |
| `roundsByDay` | When a title doesn't name its round, matches are grouped as Day 1, Day 2 and so on, so later days stay hidden until visitors open them. On unless set to `false`. |
| `defaultStage` | The stage to use when a title doesn't say and the date doesn't settle it. Leave empty to send those videos to review instead. |
| `defaultBestOf` | Series length to use when the watcher creates a match and the title doesn't say BO1/BO3/BO5. If a later map turns up, the series grows to fit. If only Map 1 ever appears, it becomes a best of 1. |
| `markUnplayedAfterHours` | Once a series has enough maps to be over and no new map has arrived for this many hours, the remaining maps are marked "wasn't played". |
| `minVideoMinutes` | Videos shorter than this are skipped as highlights or clips. |
| `maxVideoHours` / `maxLivestreamHours` | Videos longer than these are skipped as whole-day streams. The livestream limit is lower because a finished livestream that long is almost always a full broadcast day. |
| `notes` | Reminders for you. The watcher ignores them. |
| `lookbackDays` | How far back to look on each check. |
| `autoCreateTeams` / `autoCreateMatches` | Let the watcher create teams and matches it hasn't seen. Set to `false` to only fill matches you've set up yourself. |
| `ignoreTitlesWith` | Titles containing any of these words are skipped. |
| `ignoreVideos` | Video IDs to always skip. |

## How it keeps things spoiler-free
- **No YouTube text or images.** The watcher only saves a video link, the map number and the map name. It never copies titles, descriptions or thumbnails, which often show scores.
- **Locked rounds.** New rounds it creates are locked, so visitors choose when to see the matchups.
- **Unplayed maps.** Missing maps are only marked "wasn't played" once the series has clearly finished. Visitors only see that if they open that map.
- **Whole-series videos.** When a series is one long video, the watcher uses the chapter times in its description to start each map in the right place.

## Good to know
- **Speed.** Videos appear within about 30 minutes of the organiser publishing them. GitHub sometimes runs scheduled jobs late when it's busy.
- **YouTube quota.** Each check uses a tiny part of YouTube's free daily allowance. Ten channels every 30 minutes is under 500 of the 10,000 daily units.
- **Long quiet spells.** In a public repository, GitHub pauses scheduled runs after 60 days with no activity. If that happens, re-enable it on the **Actions** tab.
- **Your first event.** Every organiser writes titles a little differently, so check the review issue during your first event. A few aliases or keywords usually sort it out.
