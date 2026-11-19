// ==UserScript==
// @name         stats.fm Exporter
// @namespace    https://stats.fm/
// @version      1.0.0
// @description  Export stats.fm top lists and listening stats for several periods into one ZIP (JSON + optional CSV) with configurable fields.
// @author       SKH
// @match        https://stats.fm/*
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.0.0';
  const API = 'https://api.stats.fm/api/v1';
  const PAGE_SIZE = 500; // server-side maximum per request
  const MAX_WINDOW = 10000; // server rejects offset + limit above this
  const STORAGE_KEY = 'statsfm-exporter-config';

  // ---------------------------------------------------------------------------
  // Storage (GM_* when available, localStorage as fallback)
  // ---------------------------------------------------------------------------
  const store = {
    get(key, def) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          return v === undefined ? def : v;
        }
        const raw = localStorage.getItem(key);
        return raw == null ? def : JSON.parse(raw);
      } catch {
        return def;
      }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, val);
        else localStorage.setItem(key, JSON.stringify(val));
      } catch {
        /* storage is best-effort */
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Date helpers
  // ---------------------------------------------------------------------------
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  // ISO 8601 in local time with explicit UTC offset, e.g. 2026-11-16T00:00:00.000+02:00
  function isoLocal(ms) {
    const d = new Date(ms);
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return (
      `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
      `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    );
  }

  // Monday 00:00 local time of the week containing `now`
  function startOfIsoWeek(now) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  }

  // ---------------------------------------------------------------------------
  // Periods (mirror the site's dropdown; custom range is an extra)
  // ---------------------------------------------------------------------------
  function buildPeriods(cfg, now = new Date()) {
    const year = now.getFullYear();
    const weekStart = startOfIsoWeek(now);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const periods = [
      { key: 'today', label: 'today', dir: '1_today', query: { range: 'today' } },
      {
        key: 'this_week',
        label: 'this week (Mon-Sun)',
        dir: '2_this-week',
        query: { after: weekStart.getTime(), before: weekEnd.getTime() - 1 },
      },
      { key: 'weeks', label: '4 weeks', dir: '3_4-weeks', query: { range: 'weeks' } },
      { key: 'months', label: '6 months', dir: '4_6-months', query: { range: 'months' } },
      {
        key: 'current_year',
        label: String(year),
        dir: `5_${year}`,
        query: { after: new Date(year, 0, 1).getTime(), before: new Date(year + 1, 0, 1).getTime() - 1 },
      },
      { key: 'lifetime', label: 'lifetime', dir: '6_lifetime', query: { range: 'lifetime' } },
    ].filter((p) => cfg.periods[p.key]);

    if (cfg.custom.enabled) {
      const { from, to } = cfg.custom;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw new Error('Custom range: set both dates');
      }
      const after = new Date(`${from}T00:00:00`).getTime();
      const endDay = new Date(`${to}T00:00:00`);
      endDay.setDate(endDay.getDate() + 1);
      const before = endDay.getTime() - 1;
      if (after > before) throw new Error('Custom range: "from" is after "to"');
      periods.push({
        key: 'custom',
        label: `${from} .. ${to}`,
        dir: `7_custom_${from}_${to}`,
        query: { after, before },
      });
    }
    return periods;
  }

  function describePeriod(p) {
    if (p.query.range) return { range: p.query.range };
    return { after: isoLocal(p.query.after), before: isoLocal(p.query.before) };
  }

  // ---------------------------------------------------------------------------
  // Entities and field presets
  // ---------------------------------------------------------------------------
  const LISTS = {
    tracks: { path: '/top/tracks', kind: 'track' },
    artists: { path: '/top/artists', kind: 'artist' },
    albums: { path: '/top/albums', kind: 'album' },
    genres: { path: '/top/genres', kind: 'genre' },
  };

  const PRESETS = {
    tracks: {
      minimal: ['position', 'streams', 'playedMin: @playedMin', 'name: track.name', 'artists: @artists'],
      standard: [
        'position',
        'streams',
        'playedMin: @playedMin',
        'sharePct: @sharePct',
        'indicator',
        'name: track.name',
        'artists: @artists',
        'album: track.albums[0].name',
        'duration: @duration',
        'explicit: track.explicit',
        'id: track.id',
        'spotifyUrl: @spotifyUrl',
      ],
      full: [
        'position',
        'streams',
        'playedMs',
        'playedMin: @playedMin',
        'sharePct: @sharePct',
        'indicator',
        'id: track.id',
        'name: track.name',
        'artists: @artists',
        'artistIds: track.artists[].id',
        'album: track.albums[0].name',
        'albumId: track.albums[0].id',
        'durationMs: track.durationMs',
        'duration: @duration',
        'explicit: track.explicit',
        'spotifyPopularity: track.spotifyPopularity',
        'spotifyIds: track.externalIds.spotify',
        'appleMusicIds: track.externalIds.appleMusic',
        'image: track.albums[0].image',
        'spotifyUrl: @spotifyUrl',
        'statsfmUrl: @statsfmUrl',
      ],
    },
    artists: {
      minimal: ['position', 'streams', 'playedMin: @playedMin', 'name: artist.name'],
      standard: [
        'position',
        'streams',
        'playedMin: @playedMin',
        'sharePct: @sharePct',
        'indicator',
        'name: artist.name',
        'genres: artist.genres',
        'followers: artist.followers',
        'popularity: artist.spotifyPopularity',
        'id: artist.id',
        'spotifyUrl: @spotifyUrl',
      ],
      full: [
        'position',
        'streams',
        'playedMs',
        'playedMin: @playedMin',
        'sharePct: @sharePct',
        'indicator',
        'id: artist.id',
        'name: artist.name',
        'genres: artist.genres',
        'followers: artist.followers',
        'popularity: artist.spotifyPopularity',
        'spotifyIds: artist.externalIds.spotify',
        'appleMusicIds: artist.externalIds.appleMusic',
        'image: artist.image',
        'spotifyUrl: @spotifyUrl',
        'statsfmUrl: @statsfmUrl',
      ],
    },
    albums: {
      minimal: ['position', 'streams', 'playedMin: @playedMin', 'name: album.name'],
      standard: [
        'position',
        'streams',
        'playedMin: @playedMin',
        'sharePct: @sharePct',
        'indicator',
        'name: album.name',
        'label: album.label',
        'releaseDate: @releaseDate',
        'totalTracks: album.totalTracks',
        'genres: album.genres',
        'id: album.id',
        'spotifyUrl: @spotifyUrl',
      ],
      full: [
        'position',
        'streams',
        'playedMs',
        'playedMin: @playedMin',
        'sharePct: @sharePct',
        'indicator',
        'id: album.id',
        'name: album.name',
        'type: album.type',
        'label: album.label',
        'releaseDate: @releaseDate',
        'totalTracks: album.totalTracks',
        'genres: album.genres',
        'popularity: album.spotifyPopularity',
        'upc: album.externalIds.upc',
        'spotifyIds: album.externalIds.spotify',
        'appleMusicIds: album.externalIds.appleMusic',
        'image: album.image',
        'spotifyUrl: @spotifyUrl',
        'statsfmUrl: @statsfmUrl',
      ],
    },
    genres: {
      minimal: ['position', 'streams', 'playedMin: @playedMin', 'genre: genre.tag'],
      standard: [
        'position',
        'streams',
        'playedMin: @playedMin',
        'sharePct: @sharePct',
        'indicator',
        'genre: genre.tag',
        'topArtists: @topArtists',
      ],
      full: [
        'position',
        'streams',
        'playedMs',
        'playedMin: @playedMin',
        'sharePct: @sharePct',
        'indicator',
        'genre: genre.tag',
        'topArtists: @topArtists',
        'topArtistIds: previewArtists[].artist.id',
        'topArtistStreams: previewArtists[].streams',
        'statsfmUrl: @statsfmUrl',
      ],
    },
  };
  for (const name of Object.keys(PRESETS)) PRESETS[name].raw = ['*'];

  const presetText = (entity, preset) => PRESETS[entity][preset].join('\n');

  // ---------------------------------------------------------------------------
  // Field projection
  // ---------------------------------------------------------------------------
  const entityOf = (it) => it.track || it.artist || it.album || it.genre || null;
  const round = (x, d) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

  // Computed fields: @name in field definitions. Signature: (item, ctx) => value
  const COMPUTED = {
    playedMin: (it) => (it.playedMs == null ? null : round(it.playedMs / 60000, 1)),
    playedHours: (it) => (it.playedMs == null ? null : round(it.playedMs / 3600000, 2)),
    // Share of total listening time in the period; genres can sum above 100% (multi-genre tracks)
    sharePct: (it, ctx) => (ctx.totalMs && it.playedMs != null ? round((it.playedMs / ctx.totalMs) * 100, 2) : null),
    artists: (it) => {
      const a = entityOf(it)?.artists;
      return Array.isArray(a) && a.length ? a.map((x) => x.name).join(', ') : null;
    },
    duration: (it) => {
      const ms = it.track?.durationMs;
      if (ms == null) return null;
      const s = Math.round(ms / 1000);
      return `${Math.floor(s / 60)}:${pad(s % 60)}`;
    },
    releaseDate: (it) => {
      const r = it.album?.releaseDate;
      return r == null ? null : ymd(new Date(r));
    },
    spotifyUrl: (it, ctx) => {
      const id = entityOf(it)?.externalIds?.spotify?.[0];
      return id && ctx.kind !== 'genre' ? `https://open.spotify.com/${ctx.kind}/${id}` : null;
    },
    statsfmUrl: (it, ctx) => {
      const e = entityOf(it);
      if (!e) return null;
      if (ctx.kind === 'genre') return e.tag ? `https://stats.fm/genre/${encodeURIComponent(e.tag)}` : null;
      return e.id != null ? `https://stats.fm/${ctx.kind}/${e.id}` : null;
    },
    topArtists: (it) =>
      Array.isArray(it.previewArtists) && it.previewArtists.length
        ? it.previewArtists.map((p) => p.artist?.name).filter(Boolean).join(', ')
        : null,
  };

  // Path syntax: a.b.c | a[0].b (index) | a[].b (map over array)
  function getPath(obj, path) {
    const tokens = path.match(/\[\d*\]|[^.[\]]+/g) || [];
    const walk = (v, i) => {
      if (i === tokens.length) return v;
      if (v == null) return null;
      const t = tokens[i];
      if (t === '[]') return Array.isArray(v) ? v.map((x) => walk(x, i + 1)) : null;
      if (t[0] === '[') return Array.isArray(v) ? walk(v[Number(t.slice(1, -1))], i + 1) : null;
      return walk(v[t], i + 1);
    };
    const res = walk(obj, 0);
    return res === undefined ? null : res;
  }

  function parseFields(text, entity) {
    const fields = [];
    const errors = [];
    for (const rawLine of String(text).split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line === '*') {
        fields.push({ key: '*', raw: true });
        continue;
      }
      const idx = line.indexOf(':');
      let key = (idx >= 0 ? line.slice(0, idx) : line).trim();
      const src = (idx >= 0 ? line.slice(idx + 1) : line).trim();
      if (idx < 0 && key.startsWith('@')) key = key.slice(1);
      if (!key || !src) {
        errors.push(`${entity}: bad line "${line}"`);
        continue;
      }
      if (src.startsWith('@')) {
        const fn = COMPUTED[src.slice(1)];
        if (!fn) errors.push(`${entity}: unknown computed field ${src}`);
        else fields.push({ key, fn });
      } else {
        fields.push({ key, path: src });
      }
    }
    if (!fields.length) errors.push(`${entity}: no fields defined`);
    return { fields, errors };
  }

  function project(item, fields, ctx) {
    if (fields.some((f) => f.raw)) return item;
    const out = {};
    for (const f of fields) out[f.key] = f.fn ? f.fn(item, ctx) : getPath(item, f.path);
    return out;
  }

  // ---------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------
  function toCsv(rows, sep) {
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const cell = (v) => {
      if (v == null) return '';
      if (Array.isArray(v)) {
        v = v
          .flat(Infinity)
          .map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : x))
          .join('; ');
      } else if (typeof v === 'object') {
        v = JSON.stringify(v);
      }
      const s = String(v);
      return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [keys.map(cell).join(sep), ...rows.map((r) => keys.map((k) => cell(r[k])).join(sep))];
    return '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8 (Cyrillic) correctly
  }

  // ---------------------------------------------------------------------------
  // HTTP: rate-limited, retrying, abortable
  // ---------------------------------------------------------------------------
  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    });

  function createLimiter(concurrency, minGapMs) {
    let active = 0;
    let last = 0;
    let timer = null;
    const queue = [];
    const next = () => {
      if (active >= concurrency || !queue.length || timer) return;
      const wait = last + minGapMs - Date.now();
      if (wait > 0) {
        timer = setTimeout(() => {
          timer = null;
          next();
        }, wait);
        return;
      }
      active++;
      last = Date.now();
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          next();
        });
      next();
    };
    return (fn) =>
      new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
  }

  function createClient({ signal, onRequest }) {
    const limit = createLimiter(3, 150);
    const MAX_RETRIES = 4;
    const backoff = (attempt) => 1000 * 2 ** attempt;

    return function get(path, query = {}) {
      const url = new URL(API + path);
      for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

      return limit(async () => {
        for (let attempt = 0; ; attempt++) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          let res;
          try {
            res = await fetch(url, { signal, headers: { accept: 'application/json' } });
          } catch (e) {
            if (e.name === 'AbortError' || attempt >= MAX_RETRIES) throw e;
            await sleep(backoff(attempt), signal);
            continue;
          }
          if (res.ok) {
            onRequest?.();
            return res.json();
          }
          if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
            const retryAfter = Number(res.headers.get('retry-after'));
            await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt), signal);
            continue;
          }
          let msg = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.message) msg += `: ${body.message}`;
          } catch {
            /* non-JSON error body */
          }
          throw new ApiError(msg, res.status);
        }
      });
    };
  }

  // ---------------------------------------------------------------------------
  // ZIP (fflate when loaded via @require, built-in STORE writer otherwise)
  // ---------------------------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipStore(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const [name, data] of Object.entries(entries)) {
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // STORE
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Object.keys(entries).length, true);
    end.setUint16(10, Object.keys(entries).length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }

  function buildZip(files) {
    const enc = new TextEncoder();
    const entries = {};
    for (const [path, text] of Object.entries(files)) entries[path] = enc.encode(text);
    const ff = typeof fflate !== 'undefined' ? fflate : null; // eslint-disable-line no-undef
    if (ff?.zipSync) return { bytes: ff.zipSync(entries, { level: 6 }), engine: 'fflate (deflate)' };
    return { bytes: zipStore(entries), engine: 'built-in (store)' };
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------------------------------------------------------------------------
  // Export pipeline
  // ---------------------------------------------------------------------------
  // Notes on API behaviour (observed):
  // - offset + limit must not exceed MAX_WINDOW, deeper items are unreachable directly
  // - /top/albums may return fewer items than requested even when more pages exist
  // - /top/genres ignores offset and always returns the same list
  async function fetchList(get, userId, def, query, max, known, onPage) {
    const items = [];
    let lastPos = -Infinity;
    let capped = false;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let want = max > 0 ? Math.min(PAGE_SIZE, max - offset) : PAGE_SIZE;
      want = Math.min(want, MAX_WINDOW - offset);
      if (want <= 0) break;

      const data = await get(`/users/${encodeURIComponent(userId)}${def.path}`, { ...query, limit: want, offset });
      const page = Array.isArray(data?.items) ? data.items : [];
      if (!page.length) break;
      const firstPos = page[0].position;
      if (typeof firstPos === 'number' && firstPos <= lastPos) break; // endpoint ignored offset
      items.push(...page);
      onPage?.(page.length);
      lastPos = page[page.length - 1].position ?? lastPos;

      if (known != null && offset + want >= known) break;
      if (offset + want >= MAX_WINDOW) {
        capped = page.length === want && (max <= 0 || max > MAX_WINDOW) && (known == null || known > MAX_WINDOW);
        break;
      }
    }
    return { items, capped };
  }

  const itemKey = (it, kind) => (kind === 'genre' ? it.genre?.tag : entityOf(it)?.id);

  // Split [after, before] into calendar-year windows (local time)
  function yearWindows(after, before) {
    const windows = [];
    for (let y = new Date(after).getFullYear(); y <= new Date(before).getFullYear(); y++) {
      windows.push({
        after: Math.max(after, new Date(y, 0, 1).getTime()),
        before: Math.min(before, new Date(y + 1, 0, 1).getTime() - 1),
      });
    }
    return windows;
  }

  // Exact aggregation for lists above MAX_WINDOW: fetch per-year tops (disjoint ranges) and sum counters
  async function fetchListByYears(get, userId, def, windows, max, orderBy, onPage) {
    const parts = await Promise.all(windows.map((w) => fetchList(get, userId, def, w, 0, null, onPage)));
    const merged = new Map();
    for (const { items } of parts) {
      for (const it of items) {
        const key = itemKey(it, def.kind);
        const acc = merged.get(key);
        if (acc) {
          acc.streams += it.streams || 0;
          acc.playedMs += it.playedMs || 0;
        } else {
          merged.set(key, { ...it, streams: it.streams || 0, playedMs: it.playedMs || 0, indicator: null });
        }
      }
    }
    const primary = orderBy === 'COUNT' ? 'streams' : 'playedMs';
    const secondary = primary === 'streams' ? 'playedMs' : 'streams';
    let items = [...merged.values()].sort((a, b) => b[primary] - a[primary] || b[secondary] - a[secondary]);
    if (def.kind === 'genre') for (const it of items) it.previewArtists = null; // not mergeable
    items.forEach((it, i) => (it.position = i + 1));
    if (max > 0) items = items.slice(0, max);
    return { items, capped: parts.some((p) => p.capped) };
  }

  async function runExport(cfg, { signal, log, progress }) {
    const userId = cfg.userId.trim();
    if (!userId) throw new Error('User id is empty');

    const lists = Object.keys(LISTS).filter((k) => cfg.entities[k]);
    const fieldDefs = {};
    const fieldErrors = [];
    for (const name of lists) {
      const { fields, errors } = parseFields(cfg.fields[name], name);
      fieldDefs[name] = fields;
      fieldErrors.push(...errors);
    }
    if (fieldErrors.length) throw new Error(fieldErrors.join('\n'));

    const periods = buildPeriods(cfg);
    if (!periods.length) throw new Error('No periods selected');
    if (!lists.length && !cfg.entities.stats && !cfg.entities.dates) throw new Error('No data selected');

    let requests = 0;
    let itemsTotal = 0;
    const get = createClient({
      signal,
      onRequest: () => {
        requests++;
        progress(`requests: ${requests} | items: ${itemsTotal}`);
      },
    });

    const exportedAt = Date.now();
    const tz = browserTimeZone();
    const user = (await get(`/users/${encodeURIComponent(userId)}`)).item;
    log(`user: ${user.displayName} (${user.customId || user.id}), orderBy=${user.orderBy}`);

    // Earliest year with streams, needed only when a lifetime list hits MAX_WINDOW
    let firstYearPromise = null;
    const firstYear = () =>
      (firstYearPromise ??= get(`/users/${encodeURIComponent(userId)}/streams/stats/dates`, {
        range: 'lifetime',
        timeZone: browserTimeZone(),
      }).then((d) => Math.min(...Object.keys(d.items?.years || {}).map(Number).filter(Boolean), new Date().getFullYear())));

    const files = {};
    const indent = cfg.pretty ? 2 : 0;
    const writeJson = (path, meta, items) => {
      files[path] = JSON.stringify({ meta, items }, null, indent);
    };

    const periodReports = await Promise.all(
      periods.map(async (p) => {
        const report = { key: p.key, label: p.label, dir: p.dir, ...describePeriod(p), files: {}, errors: {} };
        const baseMeta = {
          user: user.customId || user.id,
          period: p.key,
          periodLabel: p.label,
          ...describePeriod(p),
          timeZone: tz,
          orderBy: user.orderBy,
          exportedAt: isoLocal(exportedAt),
        };

        // Stats are always fetched: needed for @sharePct and totals in meta
        let stats = null;
        try {
          stats = (await get(`/users/${encodeURIComponent(userId)}/streams/stats`, p.query)).items;
          if (cfg.entities.stats) {
            writeJson(`${p.dir}/stats.json`, { ...baseMeta, entity: 'stats' }, stats);
            report.files.stats = 1;
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          report.errors.stats = e.message;
          log(`! ${p.dir}/stats: ${e.message}`);
        }

        const tasks = lists.map(async (name) => {
          const def = LISTS[name];
          try {
            const onPage = (n) => {
              itemsTotal += n;
            };
            const known = stats?.cardinality?.[name] ?? null;
            let { items: raw, capped } = await fetchList(get, userId, def, p.query, cfg.limit, known, onPage);
            let aggregated = null;
            if (capped) {
              // Rebuild the full list from per-year tops (exact for disjoint ranges)
              let after = p.query.after;
              let before = p.query.before;
              if (p.query.range === 'lifetime') {
                after = new Date(await firstYear(), 0, 1).getTime();
                before = new Date(new Date().getFullYear() + 1, 0, 1).getTime() - 1;
              }
              if (after != null && before != null) {
                log(`${p.dir}/${name}: over ${MAX_WINDOW}, aggregating by year...`);
                const res = await fetchListByYears(get, userId, def, yearWindows(after, before), cfg.limit, user.orderBy, onPage);
                raw = res.items;
                capped = res.capped;
                aggregated = 'yearly';
              }
            }
            const ctx = { kind: def.kind, totalMs: stats?.durationMs ?? null };
            const rows = raw.map((it) => project(it, fieldDefs[name], ctx));
            const fields = fieldDefs[name].some((f) => f.raw) ? '*' : fieldDefs[name].map((f) => f.key);
            const meta = {
              ...baseMeta,
              entity: name,
              count: rows.length,
              uniqueInPeriod: stats?.cardinality?.[name] ?? null,
              limit: cfg.limit > 0 ? cfg.limit : 'all',
              truncated: cfg.limit > 0 && rows.length >= cfg.limit,
              totalPlayedMs: stats?.durationMs ?? null,
              // true = API window limit reached, list is incomplete
              capped,
              // 'yearly' = summed from per-year tops; positions recomputed, indicator unavailable
              aggregated,
              fields,
            };
            if (name === 'tracks') {
              // Every stream maps to exactly one track, so this should match totalPlayedMs for full lists
              meta.listPlayedMs = raw.reduce((s, it) => s + (it.playedMs || 0), 0);
            }
            if (capped) log(`! ${p.dir}/${name}: incomplete, API limit ${MAX_WINDOW}`);
            writeJson(`${p.dir}/${name}.json`, meta, rows);
            if (cfg.csv) files[`${p.dir}/${name}.csv`] = toCsv(rows, cfg.csvSep);
            report.files[name] = rows.length;
            log(`${p.dir}/${name}: ${rows.length}`);
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            report.errors[name] = e.message;
            log(`! ${p.dir}/${name}: ${e.message}`);
          }
        });

        if (cfg.entities.dates) {
          tasks.push(
            (async () => {
              try {
                const dates = (
                  await get(`/users/${encodeURIComponent(userId)}/streams/stats/dates`, { ...p.query, timeZone: tz })
                ).items;
                writeJson(`${p.dir}/dates.json`, { ...baseMeta, entity: 'dates' }, dates);
                report.files.dates = 1;
              } catch (e) {
                if (e.name === 'AbortError') throw e;
                report.errors.dates = e.message;
                log(`! ${p.dir}/dates: ${e.message}`);
              }
            })()
          );
        }

        await Promise.all(tasks);
        return report;
      })
    );

    const manifest = {
      tool: `statsfm-exporter ${VERSION}`,
      exportedAt: isoLocal(exportedAt),
      timeZone: tz,
      weekStart: 'monday',
      user: {
        id: user.id,
        customId: user.customId,
        displayName: user.displayName,
        orderBy: user.orderBy,
        timezone: user.timezone,
      },
      settings: {
        limit: cfg.limit > 0 ? cfg.limit : 'all',
        csv: cfg.csv,
        csvSeparator: cfg.csv ? cfg.csvSep : null,
        fields: Object.fromEntries(lists.map((n) => [n, cfg.fields[n].split('\n').filter((l) => l.trim())])),
      },
      notes: [
        'Each JSON file is { meta, items }.',
        'Positions follow the account orderBy setting (TIME = listening time, COUNT = stream count).',
        'Rolling periods (4 weeks, 6 months) depend on the export moment; see exportedAt.',
        'sharePct = playedMs / total listening time of the period; genre shares can sum above 100%.',
        `The API serves at most ${MAX_WINDOW} items per list; longer lists are rebuilt from per-year tops (meta.aggregated = "yearly").`,
        'Albums can be fewer than meta.uniqueInPeriod: the API omits some albums from top lists.',
      ],
      requests,
      periods: periodReports,
    };
    files['manifest.json'] = JSON.stringify(manifest, null, 2);

    const { bytes, engine } = buildZip(files);
    const d = new Date(exportedAt);
    const filename = `statsfm_${user.customId || user.id}_${ymd(d)}_${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
    log(`zip: ${Object.keys(files).length} files, ${(bytes.length / 1024).toFixed(0)} KB, ${engine}`);
    return { bytes, filename, files, manifest };
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    userId: '',
    periods: { today: true, this_week: true, weeks: true, months: true, current_year: true, lifetime: true },
    custom: { enabled: false, from: '', to: '' },
    entities: { tracks: true, artists: true, albums: true, genres: true, stats: true, dates: true },
    limit: 0,
    csv: true,
    csvSep: ',',
    pretty: true,
    fields: {
      tracks: presetText('tracks', 'standard'),
      artists: presetText('artists', 'standard'),
      albums: presetText('albums', 'standard'),
      genres: presetText('genres', 'standard'),
    },
  };

  function loadConfig() {
    const saved = store.get(STORAGE_KEY, {}) || {};
    const cfg = structuredClone(DEFAULT_CONFIG);
    for (const [k, v] of Object.entries(saved)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && cfg[k] && typeof cfg[k] === 'object') {
        Object.assign(cfg[k], v);
      } else if (k in cfg) {
        cfg[k] = v;
      }
    }
    return cfg;
  }

  const saveConfig = (cfg) => store.set(STORAGE_KEY, cfg);

  const RESERVED = new Set([
    'track', 'artist', 'album', 'genre', 'charts', 'settings', 'plus', 'login', 'logout', 'search',
    'privacy', 'terms', 'support', 'gift', 'redeem', 'import', 'api', '_next', 'cdn-cgi', 'compare',
  ]);

  function detectUserId() {
    const seg = location.pathname.split('/').filter(Boolean);
    if (seg[0] === 'user' && seg[1]) return decodeURIComponent(seg[1]);
    if (seg[0] && !RESERVED.has(seg[0].toLowerCase())) return decodeURIComponent(seg[0]);
    return '';
  }

  // ---------------------------------------------------------------------------
  // UI (Shadow DOM, isolated from the site's CSS)
  // ---------------------------------------------------------------------------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; background: #1db954; color: #000;
      border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 700; font-size: 13px; cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,.5); }
    .fab:hover { filter: brightness(1.1); }
    .panel { position: fixed; right: 20px; bottom: 70px; z-index: 2147483647; width: min(440px, calc(100vw - 40px)); max-height: calc(100vh - 100px);
      overflow: auto; background: #18181b; color: #e4e4e7; border: 1px solid #27272a; border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,.6); font-size: 13px; display: none; }
    .panel.open { display: block; }
    header { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px;
      border-bottom: 1px solid #27272a; font-weight: 700; position: sticky; top: 0; background: #18181b; z-index: 1; }
    header small { color: #71717a; font-weight: 400; margin-left: 6px; }
    .x { background: none; border: 0; color: #a1a1aa; font-size: 18px; cursor: pointer; }
    section { padding: 10px 14px; border-bottom: 1px solid #27272a; }
    h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #a1a1aa; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px; }
    label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    input[type=checkbox] { accent-color: #1db954; }
    input[type=text], input[type=number], input[type=date], select, textarea {
      background: #09090b; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 6px; padding: 5px 7px; font-size: 12px; }
    input[type=text] { width: 100%; }
    input[type=number] { width: 90px; }
    textarea { width: 100%; height: 170px; font-family: ui-monospace, Consolas, monospace; resize: vertical; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .tabs { display: flex; gap: 4px; margin-bottom: 6px; }
    .tab { background: #27272a; color: #a1a1aa; border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
    .tab.active { background: #1db954; color: #000; font-weight: 600; }
    .btn { background: #27272a; color: #e4e4e7; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
    .btn.primary { background: #1db954; color: #000; font-weight: 700; }
    .btn:disabled { opacity: .5; cursor: default; }
    details { margin-top: 6px; color: #a1a1aa; font-size: 12px; }
    details code { color: #e4e4e7; }
    .muted { color: #71717a; font-size: 12px; }
    .status { margin-top: 8px; color: #a1a1aa; font-size: 12px; min-height: 16px; }
    .log { margin-top: 6px; max-height: 140px; overflow: auto; background: #09090b; border-radius: 6px; padding: 6px 8px;
      font-family: ui-monospace, Consolas, monospace; font-size: 11px; white-space: pre-wrap; display: none; }
    .log.show { display: block; }
    .err { color: #f87171; }
  `;

  const PERIOD_LABELS = [
    ['today', 'today'],
    ['this_week', 'this week'],
    ['weeks', '4 weeks'],
    ['months', '6 months'],
    ['current_year', String(new Date().getFullYear())],
    ['lifetime', 'lifetime'],
  ];
  const ENTITY_LABELS = [
    ['tracks', 'tracks'],
    ['artists', 'artists'],
    ['albums', 'albums'],
    ['genres', 'genres'],
    ['stats', 'stats'],
    ['dates', 'dates (clocks)'],
  ];

  function buildUi() {
    const host = document.createElement('div');
    host.id = 'statsfm-exporter-root';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <button class="fab" part="fab">Export</button>
      <div class="panel">
        <header><span>stats.fm export<small>v${VERSION}</small></span><button class="x" title="Close">&times;</button></header>
        <section>
          <h4>User</h4>
          <input type="text" data-k="userId" placeholder="custom id or user id">
        </section>
        <section>
          <h4>Periods</h4>
          <div class="grid">
            ${PERIOD_LABELS.map(([k, l]) => `<label><input type="checkbox" data-period="${k}">${l}</label>`).join('')}
          </div>
          <div class="row">
            <label><input type="checkbox" data-k="custom.enabled">custom</label>
            <input type="date" data-k="custom.from"> <span class="muted">to</span> <input type="date" data-k="custom.to">
          </div>
        </section>
        <section>
          <h4>Data</h4>
          <div class="grid">
            ${ENTITY_LABELS.map(([k, l]) => `<label><input type="checkbox" data-entity="${k}">${l}</label>`).join('')}
          </div>
          <div class="row">
            <span>Top N per list</span><input type="number" min="0" step="50" data-k="limit">
            <span class="muted">0 = all</span>
          </div>
        </section>
        <section>
          <h4>Output</h4>
          <div class="row">
            <label><input type="checkbox" data-k="pretty">pretty JSON</label>
            <label><input type="checkbox" data-k="csv">CSV copies</label>
            <span class="muted">separator</span>
            <select data-k="csvSep"><option value=",">,</option><option value=";">;</option><option value="\t">tab</option></select>
          </div>
        </section>
        <section>
          <h4>Fields</h4>
          <div class="tabs">
            ${Object.keys(LISTS).map((n) => `<button class="tab" data-tab="${n}">${n}</button>`).join('')}
          </div>
          <textarea spellcheck="false"></textarea>
          <div class="row">
            <span class="muted">preset</span>
            <select class="preset">
              <option value="minimal">minimal</option><option value="standard">standard</option>
              <option value="full">full</option><option value="raw">raw (*)</option>
            </select>
            <button class="btn apply-preset">Apply</button>
          </div>
          <details>
            <summary>Syntax</summary>
            <p>One field per line: <code>key: path</code>. Lines starting with <code>#</code> are ignored.</p>
            <p>Path: <code>track.name</code>, <code>track.albums[0].name</code> (index), <code>track.artists[].name</code> (all items).</p>
            <p>Computed: <code>@playedMin</code> <code>@playedHours</code> <code>@sharePct</code> <code>@artists</code>
              <code>@duration</code> <code>@releaseDate</code> <code>@spotifyUrl</code> <code>@statsfmUrl</code> <code>@topArtists</code>.</p>
            <p><code>*</code> exports the raw API object.</p>
            <p>Top-level item fields: <code>position</code> <code>streams</code> <code>playedMs</code> <code>indicator</code>.</p>
          </details>
        </section>
        <section>
          <div class="row">
            <button class="btn primary go">Export ZIP</button>
            <button class="btn stop" disabled>Cancel</button>
            <button class="btn reset">Reset settings</button>
          </div>
          <div class="status"></div>
          <div class="log"></div>
        </section>
      </div>
    `;
    document.documentElement.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const $$ = (s) => [...root.querySelectorAll(s)];
    const panel = $('.panel');
    const textarea = $('textarea');
    const status = $('.status');
    const logBox = $('.log');

    let cfg = loadConfig();
    let activeTab = 'tracks';
    let controller = null;

    const getK = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
    const setK = (obj, path, v) => {
      const keys = path.split('.');
      const last = keys.pop();
      keys.reduce((o, k) => o[k], obj)[last] = v;
    };

    function render() {
      for (const el of $$('[data-k]')) {
        const v = getK(cfg, el.dataset.k);
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v ?? '';
      }
      for (const el of $$('[data-period]')) el.checked = !!cfg.periods[el.dataset.period];
      for (const el of $$('[data-entity]')) el.checked = !!cfg.entities[el.dataset.entity];
      for (const el of $$('.tab')) el.classList.toggle('active', el.dataset.tab === activeTab);
      textarea.value = cfg.fields[activeTab];
    }

    function collect() {
      for (const el of $$('[data-k]')) {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (el.dataset.k === 'limit') v = Math.max(0, parseInt(v, 10) || 0);
        setK(cfg, el.dataset.k, v);
      }
      for (const el of $$('[data-period]')) cfg.periods[el.dataset.period] = el.checked;
      for (const el of $$('[data-entity]')) cfg.entities[el.dataset.entity] = el.checked;
      cfg.fields[activeTab] = textarea.value;
      saveConfig(cfg);
    }

    function open() {
      const detected = detectUserId();
      if (detected) cfg.userId = detected;
      render();
      panel.classList.add('open');
    }

    const log = (line) => {
      logBox.classList.add('show');
      const div = document.createElement('div');
      if (line.startsWith('!')) div.className = 'err';
      div.textContent = line;
      logBox.appendChild(div);
      logBox.scrollTop = logBox.scrollHeight;
    };

    $('.fab').addEventListener('click', () => (panel.classList.contains('open') ? panel.classList.remove('open') : open()));
    $('.x').addEventListener('click', () => panel.classList.remove('open'));
    panel.addEventListener('change', collect);
    textarea.addEventListener('input', () => {
      cfg.fields[activeTab] = textarea.value;
      saveConfig(cfg);
    });

    for (const el of $$('.tab')) {
      el.addEventListener('click', () => {
        collect();
        activeTab = el.dataset.tab;
        render();
      });
    }

    $('.apply-preset').addEventListener('click', () => {
      cfg.fields[activeTab] = presetText(activeTab, $('.preset').value);
      saveConfig(cfg);
      render();
    });

    $('.reset').addEventListener('click', () => {
      cfg = structuredClone(DEFAULT_CONFIG);
      cfg.userId = detectUserId();
      saveConfig(cfg);
      render();
      status.textContent = 'Settings reset';
    });

    $('.stop').addEventListener('click', () => controller?.abort());

    $('.go').addEventListener('click', async () => {
      collect();
      controller = new AbortController();
      $('.go').disabled = true;
      $('.stop').disabled = false;
      logBox.textContent = '';
      status.classList.remove('err');
      status.textContent = 'Starting...';
      try {
        const res = await runExport(cfg, {
          signal: controller.signal,
          log,
          progress: (t) => (status.textContent = t),
        });
        downloadBytes(res.bytes, res.filename);
        const failed = res.manifest.periods.reduce((s, p) => s + Object.keys(p.errors).length, 0);
        status.textContent = `Done: ${res.filename}` + (failed ? ` (${failed} part(s) failed, see manifest.json)` : '');
      } catch (e) {
        status.classList.add('err');
        status.textContent = e.name === 'AbortError' ? 'Cancelled' : `Error: ${e.message}`;
      } finally {
        $('.go').disabled = false;
        $('.stop').disabled = true;
        controller = null;
      }
    });

    return { open };
  }

  const ui = buildUi();
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Open stats.fm exporter', ui.open);
})();