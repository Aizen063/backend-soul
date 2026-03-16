#!/usr/bin/env node
/**
 * autoImport.js — Bulk YouTube Playlist → Soul Sound Backend Importer
 *
 * Usage:
 *   node tools/music-importer/autoImport.js "PLAYLIST_URL" [--token JWT] [--api http://localhost:5000]
 *   node tools/music-importer/autoImport.js --api https://backend-soul.onrender.com "PLAYLIST_URL"
 *
 * Or via npm (from /backend):
 *   npm run import-music -- "PLAYLIST_URL"
 *   npm run import-live -- "PLAYLIST_URL"
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
const play = require('play-dl');
const sharp = require('sharp');

// ─── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, fallback = '') => {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const flagsWithValues = new Set(['--token', '--api']);
const positionalArgs = [];

for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith('--')) {
        if (flagsWithValues.has(arg)) index++;
        continue;
    }
    positionalArgs.push(arg);
}

if (!positionalArgs[0]) {
    console.error('Usage: node autoImport.js "PLAYLIST_URL" [--token JWT] [--api URL]');
    process.exit(1);
}

const PLAYLIST_URL = positionalArgs[0];

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

function normalizePlaylistUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('Playlist URL is required.');
    }

    const input = rawUrl.trim();

    // Accept raw playlist IDs as well.
    if (!input.startsWith('http://') && !input.startsWith('https://')) {
        return `https://www.youtube.com/playlist?list=${input}`;
    }

    const parsed = new URL(input);
    const listId = parsed.searchParams.get('list');

    if (listId) {
        return `https://www.youtube.com/playlist?list=${listId}`;
    }

    return input;
}

function normalizeVideoUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('Video URL is required.');
    }

    const input = rawUrl.trim();
    if (!input.startsWith('http://') && !input.startsWith('https://')) {
        return `https://www.youtube.com/watch?v=${input}`;
    }

    const parsed = new URL(input);

    if (parsed.hostname === 'youtu.be') {
        const videoId = parsed.pathname.replace(/^\//, '').trim();
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
    }

    const videoId = parsed.searchParams.get('v');
    if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
    }

    return input;
}

/**
 * Extract title + artist from YouTube metadata.
 * Priority: music metadata → title parsing → channel name → fallback.
 */
function extractMeta(info) {
    let title = (info.title || '').trim();
    const channelName = info.channel?.name || info.channel || info.uploader || '';
    const musicMeta = Array.isArray(info.music) ? info.music : [];
    const musicArtist = musicMeta.find((item) => /artist/i.test(item.song || '') || /artist/i.test(item.category || '') || /artist/i.test(item.url || ''));
    const directMusicArtist = musicMeta.find((item) => item.artist)?.artist;
    let artist = (
        info.artist ||
        directMusicArtist ||
        musicArtist?.artist ||
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
        const uploader = channelName.trim();
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

async function downloadThumbnailToJpg(url, outputPath) {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    await sharp(response.data)
        .jpeg({ quality: 90 })
        .toFile(outputPath);
}

const extensionFromMimeType = (mimeType = '') => {
    const normalized = mimeType.toLowerCase();
    if (normalized.includes('audio/webm')) return 'webm';
    if (normalized.includes('audio/mp4')) return 'm4a';
    if (normalized.includes('audio/mpeg')) return 'mp3';
    if (normalized.includes('audio/ogg')) return 'ogg';
    return 'bin';
};

async function streamToFile(sourceStream, filePath) {
    await fs.ensureDir(path.dirname(filePath));
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filePath);
        sourceStream.pipe(writer);
        sourceStream.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', resolve);
    });
}

async function downloadEntry(url, stem) {
    const info = await play.video_info(url);
    const audioFormats = (info.format || [])
        .filter((format) => typeof format.mimeType === 'string' && format.mimeType.startsWith('audio/') && format.url)
        .sort((left, right) => (Number(right.bitrate || right.averageBitrate || 0) - Number(left.bitrate || left.averageBitrate || 0)));

    if (!audioFormats.length) {
        throw new Error('No downloadable audio stream found for this video.');
    }

    const selectedFormat = audioFormats[0];
    const audioExt = extensionFromMimeType(selectedFormat.mimeType);
    const audioPath = path.join(SONGS_DIR, `${stem}.${audioExt}`);

    const audioResponse = await axios.get(selectedFormat.url, {
        responseType: 'stream',
        timeout: 120000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });
    await streamToFile(audioResponse.data, audioPath);

    const thumbnailUrl = info.video_details?.thumbnails?.at(-1)?.url;
    const jpgPath = path.join(COVERS_DIR, `${stem}.jpg`);
    let hasCover = false;

    if (thumbnailUrl) {
        try {
            await downloadThumbnailToJpg(thumbnailUrl, jpgPath);
            hasCover = true;
        } catch (thumbnailError) {
            warn(`Cover download failed: ${thumbnailError.message}`);
        }
    }

    return { info, audioPath, audioExt, jpgPath, hasCover };
}

// ─── Get flat playlist info ───────────────────────────────────────────────────
async function getPlaylistEntries(playlistUrl) {
    log('Fetching playlist info (this may take a moment)…');
    try {
        const normalizedPlaylistUrl = normalizePlaylistUrl(playlistUrl);
        const playlist = await play.playlist_info(normalizedPlaylistUrl, { incomplete: true });
        const entries = await playlist.all_videos();
        log(`Found ${entries.length} track(s) in playlist.`);
        return entries;
    } catch (playlistError) {
        const normalizedVideoUrl = normalizeVideoUrl(playlistUrl);
        const videoInfo = await play.video_basic_info(normalizedVideoUrl);
        log('Input is not a playlist. Falling back to single-video import.');
        return [videoInfo.video_details];
    }
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
        const videoUrl = entry.url || entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}` || PLAYLIST_URL;
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
        log(`Downloading: ${title}`);
        let downloadResult;
        try {
            downloadResult = await downloadEntry(videoUrl, stem);
        } catch (e) {
            err(`Download failed: ${e.message}`);
            summary.failed++;
            continue;
        }

        const { info, audioPath, audioExt, jpgPath, hasCover } = downloadResult;

        if (!fs.existsSync(audioPath)) {
            err(`Audio not found at expected path: ${audioPath}`);
            summary.failed++;
            continue;
        }

        const refreshedMeta = extractMeta(info.video_details || entry);
        if (refreshedMeta.title && refreshedMeta.title !== title) {
            log(`Resolved title: ${refreshedMeta.title}`);
        }
        if (refreshedMeta.artist && refreshedMeta.artist !== artist) {
            log(`Resolved artist: ${refreshedMeta.artist}`);
        }

        if (!hasCover) {
            warn('No thumbnail found — uploading without cover');
        } else {
            ok(`Cover saved: ${path.basename(jpgPath)}`);
        }

        // ── Step 4: find / create artist in DB ────────────────────────────
        log('Resolving artist…');
        let artistId;
        try {
            artistId = await getOrCreateArtist(refreshedMeta.artist || artist, token);
        } catch (e) {
            err(`Artist lookup/creation failed: ${e.message}`);
            summary.failed++;
            continue;
        }

        // ── Step 5: upload ─────────────────────────────────────────────────
        log('Uploading to API…');
        try {
            const form = new FormData();
            form.append('title', refreshedMeta.title || title);
            form.append('artistId', artistId);
            form.append('audio', fs.createReadStream(audioPath), `${stem}.${audioExt}`);
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

            ok(`Saved: "${refreshedMeta.title || title}" by ${refreshedMeta.artist || artist}`);
            // Mark as known to avoid re-uploading if script crashes and is re-run
            _existingTitles?.add((refreshedMeta.title || title).toLowerCase().trim());
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
