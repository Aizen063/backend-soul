#!/usr/bin/env node
/**
 * autoImport.js — Bulk YouTube Playlist → Soul Sound Backend Importer
 *
 * Usage:
 *   node tools/music-importer/autoImport.js "PLAYLIST_URL" [--token JWT] [--api http://localhost:5000]
 *
 * Or via npm (from /backend):
 *   npm run import-music -- "PLAYLIST_URL"
 *
 * Prerequisites (external):
 *   - yt-dlp  must be installed and in PATH  → https://github.com/yt-dlp/yt-dlp
 *   - ffmpeg  must be installed and in PATH  → https://ffmpeg.org/download.html
 *
 * Auth:
 *   Pass --token <JWT>  OR set IMPORT_TOKEN in .env
 *   If omitted you will be prompted for admin email/password.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const ytDlpExec = require('yt-dlp-exec');
const { execSync } = require('child_process');

// ─── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith('--')) {
    console.error('Usage: node autoImport.js "PLAYLIST_URL" [--token JWT] [--api URL]');
    process.exit(1);
}

const PLAYLIST_URL = args[0];
const getArg = (flag, fallback = '') => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const API_BASE = getArg('--api', process.env.API_BASE || 'http://localhost:5000');
const TOKEN_ARG = getArg('--token', process.env.IMPORT_TOKEN || '');

// ─── Dirs ─────────────────────────────────────────────────────────────────────
const DOWNLOAD_DIR = process.env.IMPORT_DOWNLOAD_DIR
    || (process.env.VERCEL
        ? path.join(os.tmpdir(), 'soul-sound-importer', 'downloads')
        : path.join(__dirname, 'downloads'));
const SONGS_DIR = path.join(DOWNLOAD_DIR, 'songs');
const COVERS_DIR = path.join(DOWNLOAD_DIR, 'covers');

fs.ensureDirSync(SONGS_DIR);
fs.ensureDirSync(COVERS_DIR);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const log = (msg) => console.log(`\x1b[36m[importer]\x1b[0m ${msg}`);
const ok = (msg) => console.log(`\x1b[32m[✓]\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const err = (msg) => console.log(`\x1b[31m[✗]\x1b[0m ${msg}`);

/** Sanitise a string into a safe filename stem (no extension). */
function safeStem(str) {
    return str
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase()
        .slice(0, 80);
}

/**
 * Extract title + artist from yt-dlp info dict.
 * Priority: embedded metadata → "Artist - Title" parsing → channel name → fallback.
 */
function extractMeta(info) {
    let title = (info.title || '').trim();
    // yt-dlp provides artist info in various fields depending on the source
    let artist = (
        info.artist ||
        info.creator ||
        (Array.isArray(info.creators) ? info.creators[0] : '') ||
        info.album_artist ||
        ''
    ).trim();

    // Clean up common YouTube suffixes from title
    title = title
        .replace(/\s*\(?\s*(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?\s*video|audio|visualizer|hd|hq|4k)\s*\)?\s*/gi, '')
        .replace(/\s*\[?\s*(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?\s*video|audio|visualizer|hd|hq|4k)\s*\]?\s*/gi, '')
        .replace(/\s*\|\s*$/, '')
        .trim();

    // If no artist from metadata, try parsing "Artist - Title" from the title string
    if (!artist) {
        // Try "Artist - Title", "Artist – Title", "Artist — Title"
        const dashMatch = title.match(/^(.+?)\s*[-–—]\s+(.+)$/);
        if (dashMatch) {
            artist = dashMatch[1].trim();
            title = dashMatch[2].trim();
        }
        // Try "Title | Artist" (some channels use this)
        else {
            const pipeMatch = title.match(/^(.+?)\s*\|\s+(.+)$/);
            if (pipeMatch) {
                title = pipeMatch[1].trim();
                artist = pipeMatch[2].trim();
            }
        }
    }

    // If still no artist, try the uploader/channel (often is the artist on music channels)
    if (!artist) {
        const uploader = (info.uploader || info.channel || '').trim();
        // Skip generic uploader names
        const generic = ['vevo', 'topic', 'records', 'music', 'official'];
        if (uploader && !generic.some(g => uploader.toLowerCase().includes(g) && uploader.length < 20)) {
            // Clean up " - Topic" suffix YouTube adds to auto-generated channels
            artist = uploader.replace(/\s*-\s*Topic$/i, '').trim();
        }
    }

    if (!artist) {
        artist = 'Unknown Artist';
    }

    return { title, artist };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function getToken() {
    if (TOKEN_ARG) return TOKEN_ARG;

    // Prompt for credentials if no token supplied
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(res => rl.question(q, res));

    console.log('\n\x1b[33mNo --token supplied. Login as admin:\x1b[0m');
    const email = await ask('  Email:    ');
    const password = await ask('  Password: ');
    rl.close();

    const res = await axios.post(`${API_BASE}/api/auth/login`, { email, password });
    return res.data.token;
}

// ─── Artist lookup / creation ─────────────────────────────────────────────────
let _artistCache = null;

async function getOrCreateArtist(artistName, token) {
    // Lazy-load the artist list once
    if (!_artistCache) {
        const res = await axios.get(`${API_BASE}/api/artists`);
        _artistCache = res.data.data || [];
    }

    const found = _artistCache.find(a => a.name.toLowerCase() === artistName.toLowerCase());
    if (found) return found._id;

    // Create new artist
    const res = await axios.post(
        `${API_BASE}/api/artists`,
        { name: artistName },
        { headers: { Authorization: `Bearer ${token}` } }
    );
    const newArtist = res.data.data;
    _artistCache.push(newArtist);
    ok(`Created artist: ${newArtist.name}`);
    return newArtist._id;
}

// ─── Duplicate check ──────────────────────────────────────────────────────────
let _existingTitles = null;

async function isDuplicate(title) {
    if (!_existingTitles) {
        const res = await axios.get(`${API_BASE}/api/songs`);
        _existingTitles = new Set(
            (res.data.data || []).map(s => s.title.toLowerCase().trim())
        );
    }
    return _existingTitles.has(title.toLowerCase().trim());
}

// ─── Convert thumbnail WEBP/any → JPG ────────────────────────────────────────
async function convertToJpg(inputPath, outputPath) {
    await sharp(inputPath)
        .jpeg({ quality: 90 })
        .toFile(outputPath);
}

// ─── Find thumbnail file left by yt-dlp ──────────────────────────────────────
function findThumbnail(stem, searchDir) {
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.JPEG', '.PNG', '.WEBP'];
    for (const ext of exts) {
        const candidate = path.join(searchDir, stem + ext);
        if (fs.existsSync(candidate)) return candidate;
    }
    // yt-dlp sometimes uses a slightly different stem
    try {
        const all = fs.readdirSync(searchDir);
        const match = all.find(f => f.startsWith(stem) && exts.some(e => f.endsWith(e)));
        if (match) return path.join(searchDir, match);
    } catch (_) { }
    return null;
}

// ─── Download one entry via yt-dlp ───────────────────────────────────────────
async function downloadEntry(url, outputTemplate) {
    await ytDlpExec(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 0,
        writeThumbnail: true,
        embedMetadata: true,
        noPlaylist: true,
        output: outputTemplate,
        ffmpegLocation: 'ffmpeg', // assumes ffmpeg in PATH
    });
}

// ─── Get flat playlist info ───────────────────────────────────────────────────
async function getPlaylistEntries(playlistUrl) {
    log('Fetching playlist info (this may take a moment)…');
    const info = await ytDlpExec(playlistUrl, {
        flatPlaylist: true,
        dumpSingleJson: true,
        skipDownload: true,
        quiet: true,
    });

    const entries = (info.entries || [info]).filter(Boolean);
    log(`Found ${entries.length} track(s) in playlist.`);
    return entries;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n\x1b[35m╔═══════════════════════════════════════╗');
    console.log('║    Soul Sound — Music Importer Tool   ║');
    console.log('╚═══════════════════════════════════════╝\x1b[0m\n');

    let token;
    try {
        token = await getToken();
        ok('Authenticated.');
    } catch (e) {
        err(`Auth failed: ${e.response?.data?.message || e.message}`);
        process.exit(1);
    }

    let entries;
    try {
        entries = await getPlaylistEntries(PLAYLIST_URL);
    } catch (e) {
        err(`Failed to fetch playlist: ${e.message}`);
        process.exit(1);
    }

    const summary = { success: 0, skipped: 0, failed: 0 };

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const videoUrl = entry.url || entry.webpage_url || PLAYLIST_URL;
        const rawTitle = entry.title || `Track ${i + 1}`;

        console.log(`\n─── [${i + 1}/${entries.length}] ${rawTitle} ───`);

        // ── Step 1: determine meta from flat info ──────────────────────────
        const { title, artist } = extractMeta(entry);
        log(`Title:  ${title}`);
        log(`Artist: ${artist}`);

        // ── Step 2: duplicate check ────────────────────────────────────────
        try {
            if (await isDuplicate(title)) {
                warn(`Duplicate found — skipping "${title}"`);
                summary.skipped++;
                continue;
            }
        } catch (e) {
            warn(`Could not check duplicates: ${e.message}`);
        }

        // ── Step 3: download audio + thumbnail ────────────────────────────
        // Embed artist in filename as "artist---title" so listDownloads can parse it
        const artistStem = safeStem(artist);
        const titleStem = safeStem(title);
        const stem = (artist && artist !== 'Unknown Artist')
            ? `${artistStem}---${titleStem}`
            : titleStem;
        const mp3Path = path.join(SONGS_DIR, `${stem}.mp3`);
        const jpgPath = path.join(COVERS_DIR, `${stem}.jpg`);
        const dlTemplate = path.join(SONGS_DIR, `${stem}.%(ext)s`);

        log(`Downloading: ${title}`);
        try {
            await downloadEntry(videoUrl, dlTemplate);
        } catch (e) {
            err(`Download failed: ${e.message}`);
            summary.failed++;
            continue;
        }

        // Verify mp3 exists
        if (!fs.existsSync(mp3Path)) {
            // yt-dlp may have written a slightly different path when the stem had special chars
            err(`MP3 not found at expected path: ${mp3Path}`);
            summary.failed++;
            continue;
        }

        // ── Step 4: convert thumbnail → JPG ───────────────────────────────
        log('Converting thumbnail…');
        const thumbSrc = findThumbnail(stem, SONGS_DIR);
        let hasCover = false;
        if (thumbSrc) {
            try {
                await convertToJpg(thumbSrc, jpgPath);
                // Remove original thumbnail from songs dir
                if (thumbSrc !== jpgPath) fs.removeSync(thumbSrc);
                hasCover = true;
                ok(`Cover saved: ${path.basename(jpgPath)}`);
            } catch (e) {
                warn(`Cover conversion failed: ${e.message} — uploading without cover`);
            }
        } else {
            warn('No thumbnail found — uploading without cover');
        }

        // ── Step 5: find / create artist in DB ────────────────────────────
        log('Resolving artist…');
        let artistId;
        try {
            artistId = await getOrCreateArtist(artist, token);
        } catch (e) {
            err(`Artist lookup/creation failed: ${e.message}`);
            summary.failed++;
            continue;
        }

        // ── Step 6: upload ─────────────────────────────────────────────────
        log('Uploading to API…');
        try {
            const form = new FormData();
            form.append('title', title);
            form.append('artistId', artistId);
            form.append('audio', fs.createReadStream(mp3Path), `${stem}.mp3`);
            if (hasCover && fs.existsSync(jpgPath)) {
                form.append('coverImage', fs.createReadStream(jpgPath), `${stem}.jpg`);
            }

            await axios.post(`${API_BASE}/api/songs`, form, {
                headers: {
                    ...form.getHeaders(),
                    Authorization: `Bearer ${token}`,
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });

            ok(`Saved: "${title}" by ${artist}`);
            // Mark as known to avoid re-uploading if script crashes and is re-run
            _existingTitles?.add(title.toLowerCase().trim());
            summary.success++;
        } catch (e) {
            err(`Upload failed: ${e.response?.data?.message || e.message}`);
            summary.failed++;
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n\x1b[35m╔═══════════════ DONE ════════════════╗\x1b[0m');
    ok(`Uploaded : ${summary.success}`);
    summary.skipped && warn(`Skipped  : ${summary.skipped} (duplicates)`);
    summary.failed && err(`Failed   : ${summary.failed}`);
    console.log('\x1b[35m╚═════════════════════════════════════╝\x1b[0m\n');
}

main().catch(e => {
    err(`Fatal: ${e.message}`);
    process.exit(1);
});
