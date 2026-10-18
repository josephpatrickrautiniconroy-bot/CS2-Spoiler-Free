#!/usr/bin/env node
/*
  Video watcher for the spoiler-free CS2 site.

  Every run it:
    1. reads the newest uploads from the YouTube channels in watcher/config.json,
    2. skips anything that isn't a match VOD (live streams, highlights, short clips),
    3. works out the tournament, teams, map, stage and round from each video's title,
    4. adds the video to the right map slot in auto.json (creating the match if needed),
    5. marks leftover map slots "wasn't played" once a series has clearly finished,
    6. lists anything it couldn't place in a GitHub issue labelled "needs-review".

  It never writes YouTube titles, descriptions or thumbnails into the site files,
  because those often contain scores. Only video links, map numbers and map names.

  Needs Node 20 or newer. No packages to install.
  Environment: YOUTUBE_API_KEY (required), GITHUB_TOKEN + GITHUB_REPOSITORY (for the review issue).
*/
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  config: path.join(ROOT, 'watcher', 'config.json'),
  state: path.join(ROOT, 'watcher', 'state.json'),
  data: path.join(ROOT, 'data.json'),
  auto: path.join(ROOT, 'auto.json')
};
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const YT_API = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const GH_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPOSITORY || '';
const NOW = process.env.WATCHER_NOW ? new Date(process.env.WATCHER_NOW) : new Date();
const HOUR = 3600 * 1000;

/* ---------- small helpers ---------- */
const str = v => (v === null || v === undefined) ? '' : String(v);
const arr = v => Array.isArray(v) ? v : [];
const words = s => ' ' + str(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const looseName = s => str(s).toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/s$/, '');
const slug = s => str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const shortHash = s => createHash('sha1').update(str(s)).digest('hex').slice(0, 8);
const escapeRe = s => str(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withoutUpdatedAt = o => { const c = Object.assign({}, o); delete c.updatedAt; return JSON.stringify(c); };
const log = msg => console.log(msg);
const warn = msg => console.log('::warning::' + msg);

async function readJson(file, fallback) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(text); } catch (e) { throw new Error(path.relative(ROOT, file) + ' is not valid JSON: ' + e.message); }
}
async function writeJsonIfChanged(file, obj) {
  const next = JSON.stringify(obj, null, 2) + '\n';
  let prev = '';
  try { prev = await readFile(file, 'utf8'); } catch (e) { /* new file */ }
  if (prev === next) return false;
  await writeFile(file, next);
  return true;
}
function toSeconds(v) {
  v = str(v).trim().toLowerCase();
  if (!v) return 0;
  if (/^\d+$/.test(v)) return +v;
  if (/^\d+(:\d{1,2}){1,2}$/.test(v)) return v.split(':').reduce((a, n) => a * 60 + (+n), 0);
  return 0;
}
function isoDurationMinutes(d) {
  const m = str(d).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) + (+m[4] || 0) / 60;
}

/* ---------- reading titles ---------- */
const MAPS = [
  ['Ancient', ['ancient']], ['Anubis', ['anubis']], ['Dust2', ['dust2', 'dust 2', 'dust ii', 'dust two']],
  ['Inferno', ['inferno']], ['Mirage', ['mirage']], ['Nuke', ['nuke']], ['Overpass', ['overpass']],
  ['Train', ['train']], ['Vertigo', ['vertigo']], ['Cache', ['cache']], ['Cobblestone', ['cobblestone', 'cobble']]
];
function findMapName(text) {
  const t = words(text);
  for (const [name, keys] of MAPS) if (keys.some(k => t.includes(' ' + k + ' '))) return name;
  return '';
}
function findMapNumber(text) {
  const m = str(text).match(/\b(?:map|game)\s*#?\s*([1-5])\b/i);
  return m ? +m[1] : 0;
}
function findBestOf(text) {
  const m = str(text).match(/\b(?:bo|best\s*of\s*)([135])\b/i);
  return m ? +m[1] : 0;
}
const ROUND_PATTERNS = [
  [/grand\s*-?\s*finals?/i, () => 'Grand final'],
  [/lower\s*(?:bracket\s*)?finals?/i, () => 'Lower bracket final'],
  [/upper\s*(?:bracket\s*)?finals?/i, () => 'Upper bracket final'],
  [/semi\s*-?\s*finals?/i, () => 'Semi-finals'],
  [/quarter\s*-?\s*finals?/i, () => 'Quarter-finals'],
  [/third\s*-?\s*place|3rd\s*place|bronze\s*match/i, () => 'Third-place match'],
  [/round\s*of\s*(\d+)/i, m => 'Round of ' + m[1]],
  [/\bround\s*(\d{1,2})\b/i, m => 'Round ' + m[1]],
  [/winner(?:['’]?s)?\s*match(?:es)?/i, () => 'Winners’ match'],
  [/opening\s*match(?:es)?/i, () => 'Opening matches'],
  [/elimination\s*match(?:es)?/i, () => 'Elimination matches'],
  [/decider\s*match(?:es)?/i, () => 'Decider matches'],
  [/\bfinals?\b/i, () => 'Final']
];
function findRound(text) {
  for (const [re, name] of ROUND_PATTERNS) { const m = str(text).match(re); if (m) return name(m); }
  return '';
}
function findTeams(title, teams) {
  const T = words(title);
  const hits = [];
  for (const tm of teams) {
    for (const cand of [tm.name].concat(arr(tm.aliases))) {
      const c = words(cand).trim();
      if (!c) continue;
      const i = T.indexOf(' ' + c + ' ');
      if (i >= 0) hits.push({ id: tm.id, start: i, end: i + c.length + 1, len: c.length });
    }
  }
  hits.sort((a, b) => b.len - a.len);
  const kept = [];
  for (const hit of hits) {
    if (kept.some(k => k.id !== hit.id && hit.start < k.end && k.start < hit.end)) continue;
    kept.push(hit);
  }
  const first = new Map();
  for (const hit of kept) { const e = first.get(hit.id); if (!e || hit.start < e.start) first.set(hit.id, hit); }
  return [...first.values()].sort((a, b) => a.start - b.start).map(x => x.id);
}
/* "NAVI vs FaZe | Map 1 ..." -> ["NAVI", "FaZe"] */
function vsSplit(title) {
  const SEP = '|\\-–—:·•\\[\\](),/';
  const re = new RegExp('(?:^|[' + SEP + ']\\s*)([^' + SEP + ']{1,40}?)\\s+(?:vs\\.?|v\\.?|versus)\\s+([^' + SEP + ']{1,40}?)\\s*(?=$|[' + SEP + '])', 'i');
  const m = str(title).match(re);
  if (!m) return null;
  const clean = s => s.replace(/^\s*(?:\d+\s+)+|(?:\s+\d+)+\s*$/g, '').trim();
  const a = clean(m[1]), b = clean(m[2]);
  return (a && b && a.toLowerCase() !== b.toLowerCase()) ? [a, b] : null;
}
/* Chapters in a description, for whole-series videos: "1:02:03 Map 2 - Mirage" */
function parseChapters(desc) {
  const out = [];
  for (const line of str(desc).split(/\r?\n/)) {
    const m = line.match(/^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—:|]?\s*(.+?)\s*$/);
    if (!m) continue;
    const num = findMapNumber(m[2]);
    const name = findMapName(m[2]);
    if (!num && !name) continue;
    out.push({ seconds: toSeconds(m[1]), num, name });
  }
  const used = new Set();
  return out.map((c, i) => ({ index: c.num ? c.num - 1 : i, seconds: c.seconds, name: c.name }))
    .filter(c => { if (used.has(c.index)) return false; used.add(c.index); return true; });
}

/* ---------- YouTube ---------- */
async function yt(endpoint, params) {
  const url = new URL(YT_API + '/' + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', YT_KEY);
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (body.error && body.error.message) || ('HTTP ' + r.status);
    throw new Error('YouTube ' + endpoint + ' request failed: ' + msg);
  }
  return body;
}

/* ---------- GitHub review issue ---------- */
async function gh(method, url, body) {
  const r = await fetch(GH_API + url, {
    method,
    headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cs2-video-watcher', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return null;
  const json = await r.json().catch(() => null);
  if (!r.ok && r.status !== 422) throw new Error('GitHub ' + method + ' ' + url + ' failed: HTTP ' + r.status);
  return json;
}
async function updateReviewIssue(pending) {
  if (!GH_TOKEN || !GH_REPO) return;
  try {
    await gh('POST', '/repos/' + GH_REPO + '/labels', { name: 'needs-review', color: 'd93f0b', description: 'Videos the watcher could not place' });
    const open = await gh('GET', '/repos/' + GH_REPO + '/issues?labels=needs-review&state=open&per_page=1');
    const issue = Array.isArray(open) && open[0];
    const items = Object.entries(pending);
    if (!items.length) {
      if (issue) {
        await gh('POST', '/repos/' + GH_REPO + '/issues/' + issue.number + '/comments', { body: 'All videos are placed now. Closing.' });
        await gh('PATCH', '/repos/' + GH_REPO + '/issues/' + issue.number, { state: 'closed' });
      }
      return;
    }
    const lines = [
      'The video watcher found these videos but couldn’t place them on the site. Fix the cause (usually a team name in **Teams** or a setting in `watcher/config.json`) and the next run will pick them up. To skip a video for good, add its ID to `ignoreVideos` in `watcher/config.json`.',
      '',
      'Video titles are hidden below each item because they may contain scores.',
      ''
    ];
    for (const [id, p] of items) {
      lines.push('- [ ] **' + id + '** — ' + p.reason + ' ([open video](https://youtu.be/' + id + '))');
      lines.push('  <details><summary>Show title (may contain spoilers)</summary>' + str(p.title).replace(/[<>]/g, '') + '</details>');
    }
    const body = lines.join('\n');
    if (issue) { if (issue.body !== body) await gh('PATCH', '/repos/' + GH_REPO + '/issues/' + issue.number, { body }); }
    else await gh('POST', '/repos/' + GH_REPO + '/issues', { title: 'Videos that need a quick look', body, labels: ['needs-review'] });
  } catch (e) {
    warn('Couldn’t update the review issue: ' + e.message);
  }
}

/* ---------- main ---------- */
async function main() {
  const config = await readJson(FILES.config, null);
  if (!config) throw new Error('watcher/config.json is missing.');
  const site = await readJson(FILES.data, { tournaments: [], teams: [] });
  const auto = await readJson(FILES.auto, {});
  const state = await readJson(FILES.state, {});
  auto.version = 1;
  auto.teams = arr(auto.teams);
  auto.matches = arr(auto.matches);
  auto.videos = (auto.videos && typeof auto.videos === 'object') ? auto.videos : {};
  state.version = 1;
  for (const k of ['uploads', 'seen', 'pending', 'matchActivity', 'stageStart']) if (!state[k] || typeof state[k] !== 'object') state[k] = {};

  const opts = {
    channels: arr(config.channels).map(str).filter(Boolean),
    tournaments: arr(config.tournaments),
    unplayedHours: +config.markUnplayedAfterHours || 12,
    minMinutes: config.minVideoMinutes === undefined ? 15 : +config.minVideoMinutes,
    maxVideoHours: +config.maxVideoHours || 8,
    maxLivestreamHours: +config.maxLivestreamHours || 4,
    stageGraceHours: config.stageDateGraceHours === undefined ? 18 : +config.stageDateGraceHours,
    uploadDelayHours: config.uploadDelayHours === undefined ? 4 : +config.uploadDelayHours,
    lookbackDays: +config.lookbackDays || 10,
    autoTeams: config.autoCreateTeams !== false,
    autoMatches: config.autoCreateMatches !== false,
    skipWords: arr(config.ignoreTitlesWith).map(s => str(s).toLowerCase()).filter(Boolean),
    ignoreVideos: new Set(arr(config.ignoreVideos).map(str))
  };

  // If the settings changed, look again at videos that were skipped before.
  const configHash = shortHash(JSON.stringify(config));
  if (state.configHash !== configHash) {
    for (const [id, s] of Object.entries(state.seen)) if (s.status === 'skipped') delete state.seen[id];
    state.configHash = configHash;
  }

  const hidden = new Set(arr(site.hiddenAuto).map(str));
  const allTeams = () => arr(site.teams).concat(auto.teams.filter(t => !hidden.has(t.id) && !arr(site.teams).some(x => x.id === t.id)));
  const siteMatches = t => {
    const out = [];
    arr(t.stages).forEach(s => arr(s.rounds).forEach(r => arr(r.matches).forEach(m => out.push({ m, stage: s.name, round: r.name, fromSite: true }))));
    auto.matches.filter(am => am.tournamentId === t.id && !hidden.has(am.id) && !out.some(o => o.m.id === am.id))
      .forEach(am => out.push({ m: am, stage: am.stage, round: am.round, fromSite: false }));
    return out;
  };
  const autoSlots = (mid, bo) => {
    const v = auto.videos[mid] || (auto.videos[mid] = { maps: [] });
    while (v.maps.length < bo) v.maps.push({ video: '', start: '', name: '', notPlayed: false });
    return v.maps;
  };
  const siteSlot = (m, i) => arr(m.maps)[i] || null;
  const slotVideo = (m, i) => {
    const s = siteSlot(m, i);
    if (s && s.video) return s.video;
    const a = auto.videos[m.id] && auto.videos[m.id].maps[i];
    return (a && a.video) || '';
  };
  const videoIdOf = url => { const m = str(url).match(/(?:youtu\.be\/|v=|embed\/|live\/)([\w-]{11})/); return m ? m[1] : str(url); };

  const summary = { checked: 0, added: 0, review: 0, unplayed: 0, created: 0 };

  if (!YT_KEY) {
    warn('YOUTUBE_API_KEY isn’t set, so no new videos were checked. Add it under Settings → Secrets and variables → Actions.');
  } else if (!opts.channels.length) {
    warn('No channels are listed in watcher/config.json yet, so there was nothing to check.');
  } else {
    /* 1. uploads playlist for each channel */
    for (const ch of opts.channels) {
      if (state.uploads[ch]) continue;
      const q = /^UC[\w-]{22}$/.test(ch) ? { part: 'contentDetails', id: ch } : { part: 'contentDetails', forHandle: ch.startsWith('@') ? ch : '@' + ch };
      try {
        const res = await yt('channels', q);
        const pl = res.items && res.items[0] && res.items[0].contentDetails.relatedPlaylists.uploads;
        if (pl) state.uploads[ch] = pl;
        else warn('Couldn’t find the YouTube channel "' + ch + '". Check it in watcher/config.json.');
      } catch (e) { warn(e.message); }
    }

    /* 2. newest uploads per channel */
    const since = NOW.getTime() - opts.lookbackDays * 24 * HOUR;
    const candidates = new Map();
    for (const ch of opts.channels) {
      const pl = state.uploads[ch];
      if (!pl) continue;
      try {
        const res = await yt('playlistItems', { part: 'contentDetails', playlistId: pl, maxResults: '50' });
        for (const it of arr(res.items)) {
          const id = it.contentDetails && it.contentDetails.videoId;
          const at = Date.parse(it.contentDetails.videoPublishedAt || '');
          if (!id || !at || at < since) continue;
          if (state.seen[id] && !state.pending[id]) continue;
          candidates.set(id, ch);
        }
      } catch (e) { warn(e.message); }
    }
    for (const id of Object.keys(state.pending)) if (!candidates.has(id)) candidates.set(id, state.pending[id].channel || '');

    /* 3. details for new videos, 50 at a time */
    const ids = [...candidates.keys()].filter(id => !opts.ignoreVideos.has(id));
    for (const id of Object.keys(state.pending)) if (opts.ignoreVideos.has(id)) { delete state.pending[id]; state.seen[id] = { status: 'ignored', at: NOW.toISOString() }; }
    const videos = [];
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const res = await yt('videos', { part: 'snippet,contentDetails,liveStreamingDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
        videos.push(...arr(res.items));
      } catch (e) { warn(e.message); }
    }
    videos.sort((a, b) => Date.parse(a.snippet.publishedAt) - Date.parse(b.snippet.publishedAt));

    /* 4. place each video */
    for (const v of videos) {
      summary.checked++;
      const id = v.id;
      const channel = candidates.get(id);
      const title = str(v.snippet.title);
      const desc = str(v.snippet.description);
      const markSeen = status => { state.seen[id] = { status, at: NOW.toISOString() }; delete state.pending[id]; };
      const review = reason => { state.pending[id] = { reason, title, channel, at: (state.pending[id] && state.pending[id].at) || NOW.toISOString() }; state.seen[id] = { status: 'review', at: NOW.toISOString() }; summary.review++; };

      if (v.snippet.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none') continue; // check again once it's a VOD
      const lower = title.toLowerCase();
      if (opts.skipWords.some(w => lower.includes(w))) { markSeen('skipped'); continue; }
      // Too short = highlights or clips. Too long = a whole day's stream.
      const minutes = isoDurationMinutes(v.contentDetails.duration);
      if (minutes < opts.minMinutes || minutes > opts.maxVideoHours * 60) { markSeen('skipped'); continue; }
      const wasLive = !!(v.liveStreamingDetails && v.liveStreamingDetails.actualStartTime);
      if (wasLive && minutes > opts.maxLivestreamHours * 60) { markSeen('skipped'); continue; }
      const publishedAt = Date.parse(v.snippet.publishedAt);

      // which tournament?
      const tconf = opts.tournaments.find(tc =>
        (!arr(tc.channels).length || arr(tc.channels).includes(channel)) &&
        arr(tc.titleKeywords).some(k => words(title).includes(words(k))));
      if (!tconf) { markSeen('skipped'); continue; }
      const t = arr(site.tournaments).find(x => looseName(x.name) === looseName(tconf.siteTournament));
      if (!t) { review('The tournament "' + tconf.siteTournament + '" from config.json isn’t on the site. Add it in edit mode with exactly that name.'); continue; }
      // Read the rest of the title without the event name, so "World Final" in an event name isn't taken as a round.
      let rest = title;
      for (const k of arr(tconf.titleKeywords)) rest = rest.replace(new RegExp(escapeRe(k), 'ig'), ' | ');

      // which teams?
      let teamIds = findTeams(rest, allTeams());
      if (teamIds.length > 2) { review('More than two known team names are in the title.'); continue; }
      if (teamIds.length < 2) {
        const pair = vsSplit(rest);
        if (!pair) { review('Couldn’t find two team names in the title.'); continue; }
        const ids2 = pair.map(name => {
          const known = findTeams(name, allTeams());
          if (known.length === 1) return known[0];
          if (!opts.autoTeams) return '';
          const tid = 'auto-tm-' + slug(name);
          if (!auto.teams.some(x => x.id === tid)) auto.teams.push({ id: tid, name, aliases: [] });
          return tid;
        });
        if (!ids2[0] || !ids2[1] || ids2[0] === ids2[1]) { review('Unknown team in the title. Add the team (or another name for it) in Teams.'); continue; }
        teamIds = ids2;
      }

      // which stage and round?
      let roundName = findRound(rest);
      let stageName = '';
      const stageMap = (tconf.stages && typeof tconf.stages === 'object') ? tconf.stages : {};
      for (const [sname, keys] of Object.entries(stageMap)) if (arr(keys).some(k => words(rest).includes(words(k)))) { stageName = sname; break; }
      // No stage words in the title: use the stage that was being played when the video came out.
      const stageDates = (tconf.stageDates && typeof tconf.stageDates === 'object') ? tconf.stageDates : {};
      const windowOf = w => Array.isArray(w) && w.length === 2 ? [Date.parse(w[0] + 'T00:00:00Z'), Date.parse(w[1] + 'T23:59:59Z') + opts.stageGraceHours * HOUR] : null;
      if (!stageName) {
        const hits = Object.entries(stageDates).filter(([, w]) => { const win = windowOf(w); return win && publishedAt >= win[0] && publishedAt <= win[1]; });
        if (hits.length === 1) stageName = hits[0][0];
      }
      if (!stageName && tconf.defaultStage) stageName = str(tconf.defaultStage);
      if (!stageName && arr(t.stages).length === 1) stageName = t.stages[0].name;
      // No round in the title: group by day of the stage, so later days stay hidden until opened.
      // The stage's first day comes from stageDates, or else from the first video seen for that stage.
      if (!roundName && stageName && tconf.roundsByDay !== false) {
        const dayStart = ts => { const d = new Date(ts - opts.uploadDelayHours * HOUR); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
        const key = t.id + '|' + looseName(stageName);
        const win = windowOf(stageDates[stageName]);
        if (!win && !state.stageStart[key]) state.stageStart[key] = new Date(dayStart(publishedAt)).toISOString();
        const start = win ? win[0] : Date.parse(state.stageStart[key]);
        const day = Math.floor((dayStart(publishedAt) - start) / (24 * HOUR)) + 1;
        roundName = 'Day ' + Math.max(1, day);
      }
      const boByRound = (tconf.bestOfByRound && typeof tconf.bestOfByRound === 'object') ? tconf.bestOfByRound : {};
      const roundBo = roundName ? Object.entries(boByRound).find(([r]) => looseName(r) === looseName(roundName)) : null;

      // which match?
      const pairKey = [...teamIds].sort().join('|');
      const pool = siteMatches(t).filter(o => [o.m.a, o.m.b].sort().join('|') === pairKey);
      const bo = findBestOf(rest);
      let entry = null;
      if (pool.length === 1) entry = pool[0];
      else if (pool.length > 1) {
        entry = pool.find(o => stageName && looseName(o.stage) === looseName(stageName) && roundName && looseName(o.round) === looseName(roundName))
          || pool.find(o => roundName && looseName(o.round) === looseName(roundName))
          || pool.find(o => arr(o.m.maps).some((_, i) => !slotVideo(o.m, i)) || !arr(o.m.maps).length)
          || null;
        if (!entry) { review('These two teams play more than once and the title doesn’t say which match this is.'); continue; }
      }
      if (!entry) {
        if (!opts.autoMatches) { review('No match between these teams on the site yet.'); continue; }
        if (!stageName) { review('Couldn’t tell which stage this match belongs to. Add stage keywords in config.json.'); continue; }
        const m = {
          id: 'auto-m-' + shortHash(t.id + '|' + pairKey + '|' + stageName + '|' + (roundName || '')),
          tournamentId: t.id, tournament: t.name, stage: stageName, round: roundName || 'New matches',
          a: teamIds[0], b: teamIds[1], bo: bo || (roundBo && +roundBo[1]) || +tconf.defaultBestOf || 3,
          boGuessed: !bo && !roundBo,
          date: new Date(v.snippet.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
          maps: []
        };
        if (!auto.matches.some(x => x.id === m.id)) { auto.matches.push(m); summary.created++; }
        entry = { m: auto.matches.find(x => x.id === m.id), stage: stageName, round: m.round, fromSite: false };
      }
      const m = entry.m;
      let seriesLen = [1, 3, 5].includes(+m.bo) ? +m.bo : 3;

      // which map slot(s)?
      let placements = [];
      const num = findMapNumber(rest);
      const mapName = findMapName(rest);
      if (num) placements = [{ index: num - 1, seconds: 0, name: mapName }];
      else {
        const chapters = parseChapters(desc);
        if (chapters.length >= 2 || (chapters.length === 1 && seriesLen === 1)) placements = chapters;
        else if (mapName) {
          // Only a map name: use the slot already named after it, otherwise the next empty one
          // (videos are handled in upload order, and organisers upload maps in order).
          const named = i => { const s = siteSlot(m, i); const a = auto.videos[m.id] && auto.videos[m.id].maps[i]; return (s && s.name) || (a && a.name) || ''; };
          let idx = -1;
          for (let i = 0; i < seriesLen; i++) if (looseName(named(i)) === looseName(mapName)) { idx = i; break; }
          if (idx < 0) for (let i = 0; i < seriesLen; i++) if (!slotVideo(m, i)) { idx = i; break; }
          if (idx >= 0) placements = [{ index: idx, seconds: 0, name: mapName }];
        }
        if (!placements.length && seriesLen === 1) placements = [{ index: 0, seconds: 0, name: mapName }];
      }
      if (!placements.length) { review('Couldn’t tell which map this video is. The title has no map number and the description has no chapters.'); continue; }
      // A match the watcher created can grow: Map 2 turning up means it's at least a best of 3.
      const maxIdx = Math.max(...placements.map(p => p.index));
      if (!entry.fromSite && maxIdx >= seriesLen && maxIdx < 5) { m.bo = maxIdx < 3 ? 3 : 5; m.boGuessed = false; seriesLen = m.bo; }
      if (placements.some(p => p.index < 0 || p.index >= seriesLen)) { review('The map number is higher than the series length on the site.'); continue; }

      const slots = autoSlots(m.id, seriesLen);
      let conflict = false, placed = 0;
      for (const p of placements) {
        const existing = slotVideo(m, p.index);
        if (existing && videoIdOf(existing) !== id) { conflict = true; continue; }
        if (existing) continue;
        slots[p.index] = { video: 'https://youtu.be/' + id, start: p.seconds ? String(p.seconds) : '', name: p.name || slots[p.index].name || '', notPlayed: false };
        placed++;
      }
      if (conflict && !placed) { review('That map already has a different video on the site.'); continue; }
      if (placed) { state.matchActivity[m.id] = NOW.toISOString(); summary.added += placed; }
      markSeen('used');
    }
  }

  /* 5. mark maps that weren't played */
  for (const t of arr(site.tournaments)) {
    for (const o of siteMatches(t)) {
      const m = o.m;
      const bo = [1, 3, 5].includes(+m.bo) ? +m.bo : 3;
      const last = Date.parse(state.matchActivity[m.id] || '');
      if (!last || NOW.getTime() - last < opts.unplayedHours * HOUR) continue;
      const filled = [];
      for (let i = 0; i < bo; i++) if (slotVideo(m, i)) filled.push(i);
      // A guessed series length with only Map 1 after the wait was a best of 1.
      if (!o.fromSite && m.boGuessed && bo > 1 && filled.length === 1 && filled[0] === 0) {
        m.bo = 1; m.boGuessed = false;
        if (auto.videos[m.id]) auto.videos[m.id].maps.length = 1;
        continue;
      }
      if (bo === 1) continue;
      if (filled.length < Math.ceil(bo / 2) || filled.length >= bo) continue;
      const lastFilled = Math.max(...filled);
      const slots = autoSlots(m.id, bo);
      for (let i = lastFilled + 1; i < bo; i++) {
        const s = siteSlot(m, i);
        if (s && (s.video || s.notPlayed)) continue;
        if (!slots[i].notPlayed && !slots[i].video) { slots[i].notPlayed = true; summary.unplayed++; }
      }
    }
  }

  /* 6. tidy up and save */
  const forgetBefore = NOW.getTime() - Math.max(60, opts.lookbackDays * 3) * 24 * HOUR;
  for (const [id, s] of Object.entries(state.seen)) if (Date.parse(s.at) < forgetBefore && !state.pending[id]) delete state.seen[id];
  for (const [id, p] of Object.entries(state.pending)) if (Date.parse(p.at) < forgetBefore) delete state.pending[id];

  const before = await readJson(FILES.auto, {});
  if (withoutUpdatedAt(auto) !== withoutUpdatedAt(before)) auto.updatedAt = NOW.toISOString();
  else auto.updatedAt = before.updatedAt || '';
  await writeJsonIfChanged(FILES.auto, auto);
  await writeJsonIfChanged(FILES.state, state);
  await updateReviewIssue(state.pending);

  const pendingCount = Object.keys(state.pending).length;
  const line = 'Checked ' + summary.checked + ' new videos: added ' + summary.added + ' map videos, created ' + summary.created + ' matches, marked ' + summary.unplayed + ' maps as not played. Waiting for review: ' + pendingCount + '.';
  log(line);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '### Video watcher\n\n' + line + '\n');
}

main().catch(e => { console.error('::error::' + e.message); process.exit(1); });
