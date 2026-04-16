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
const SpotifyWebApi = require('spotify-web-api-node');
const ytDlpExec = require('yt-dlp-exec');
const sharp = require('sharp');

const importEnvPath = path.join(__dirname, '../../.env.import');
const defaultEnvPath = path.join(__dirname, '../../.env');

if (fs.existsSync(importEnvPath)) {
    require('dotenv').config({ path: importEnvPath });
} else {
    require('dotenv').config({ path: defaultEnvPath });
}

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

const API_BASE = getArg('--api', process.env.API_BASE || 'http://localhost:5000');
const TOKEN_ARG = getArg('--token', process.env.IMPORT_TOKEN || '');
const PREFER_YTDLP =
    process.env.IMPORT_PREFER_YTDLP === 'true'
    || process.env.RENDER === 'true'
    || !!process.env.VERCEL;
const MAX_SPOTIFY_PLAYLIST_TRACKS = Number(process.env.IMPORT_SPOTIFY_MAX_TRACKS || '120');

const spotifyClientId = (process.env.SPOTIFY_CLIENT_ID || '').trim();
const spotifyClientSecret = (process.env.SPOTIFY_CLIENT_SECRET || '').trim();
const spotifyApi = spotifyClientId && spotifyClientSecret
    ? new SpotifyWebApi({ clientId: spotifyClientId, clientSecret: spotifyClientSecret })
    : null;
let spotifyAccessTokenExpiresAt = 0;

let _ytDlpCookiesFilePath = null;

async function getYtDlpCookiesFilePath() {
    if (_ytDlpCookiesFilePath) return _ytDlpCookiesFilePath;

    if (process.env.YTDLP_COOKIE_FILE && await fs.pathExists(process.env.YTDLP_COOKIE_FILE)) {
        _ytDlpCookiesFilePath = process.env.YTDLP_COOKIE_FILE;
        return _ytDlpCookiesFilePath;
    }

    const cookiesText = process.env.YTDLP_COOKIES_TEXT;
    const cookiesBase64 = process.env.YTDLP_COOKIES_B64;
    let decoded = '';

    if (cookiesText && cookiesText.trim()) {
        decoded = cookiesText;
    } else if (cookiesBase64 && cookiesBase64.trim()) {
        try {
            decoded = Buffer.from(cookiesBase64, 'base64').toString('utf8');
        } catch {
            warn('Could not decode YTDLP_COOKIES_B64. Falling back without cookies.');
            return null;
        }
    }

    if (!decoded.trim()) return null;

    const cookiePath = path.join(os.tmpdir(), 'soul-sound-ytdlp-cookies.txt');
    await fs.writeFile(cookiePath, decoded, 'utf8');
    _ytDlpCookiesFilePath = cookiePath;
    return _ytDlpCookiesFilePath;
}

// ─── Dirs ─────────────────────────────────────────────────────────────────────
const DOWNLOAD_DIR = process.env.IMPORT_DOWNLOAD_DIR
    || (process.env.VERCEL
        ? path.join(os.tmpdir(), 'soul-sound-importer', 'downloads')
        : path.join(__dirname, 'downloads'));
const SONGS_DIR = path.join(DOWNLOAD_DIR, 'songs');
const COVERS_DIR = path.join(DOWNLOAD_DIR, 'covers');
const META_DIR = path.join(DOWNLOAD_DIR, 'metadata');

fs.ensureDirSync(SONGS_DIR);
fs.ensureDirSync(COVERS_DIR);
fs.ensureDirSync(META_DIR);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const log = (msg) => console.log(`\x1b[36m[importer]\x1b[0m ${msg}`);
const ok = (msg) => console.log(`\x1b[32m[✓]\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const err = (msg) => console.log(`\x1b[31m[✗]\x1b[0m ${msg}`);

process.on('unhandledRejection', (reason) => {
    err(`Unhandled rejection: ${reason?.message || reason}`);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    err(`Uncaught exception: ${error?.message || error}`);
    process.exit(1);
});

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

function extractAlbumName(info, fallbackAlbum = '') {
    const details = info?.video_details || info || {};
    const musicMeta = Array.isArray(details.music) ? details.music : [];

    const musicAlbum = musicMeta.find((item) => {
        const joined = `${item?.song || ''} ${item?.category || ''} ${item?.url || ''}`.toLowerCase();
        return joined.includes('album');
    })?.album;

    const candidate = (
        details.album?.name
        || details.album
        || musicAlbum
        || details.playlist
        || fallbackAlbum
        || ''
    ).toString().trim();

    if (!candidate || /^unknown album$/i.test(candidate)) return '';
    return candidate;
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
    const token = res.data?.data?.token || res.data?.token;
    if (!token) {
        throw new Error(`Login succeeded but no token was returned by ${API_BASE}/api/auth/login`);
    }
    const role = res.data?.data?.role;
    return { token, role };
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

const extensionFromStreamType = (streamType = '') => {
    const normalized = String(streamType).toLowerCase();
    if (normalized.includes('webm')) return 'webm';
    if (normalized.includes('ogg')) return 'ogg';
    if (normalized.includes('opus')) return 'webm';
    return 'm4a';
};

const toAbsoluteHttpUrl = (value) => {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    return null;
};

function parseSpotifyTrackId(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const input = rawUrl.trim();

    const uriMatch = input.match(/^spotify:track:([a-zA-Z0-9]+)$/i);
    if (uriMatch) return uriMatch[1];

    if (!input.startsWith('http://') && !input.startsWith('https://')) return '';

    try {
        const parsed = new URL(input);
        if (!/spotify\.com$/i.test(parsed.hostname)) return '';
        const trackMatch = parsed.pathname.match(/\/track\/([a-zA-Z0-9]+)/i);
        return trackMatch ? trackMatch[1] : '';
    } catch {
        return '';
    }
}

function parseSpotifyPlaylistId(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const input = rawUrl.trim();

    const uriMatch = input.match(/^spotify:playlist:([a-zA-Z0-9]+)$/i);
    if (uriMatch) return uriMatch[1];

    if (!input.startsWith('http://') && !input.startsWith('https://')) return '';

    try {
        const parsed = new URL(input);
        if (!/spotify\.com$/i.test(parsed.hostname)) return '';
        const listMatch = parsed.pathname.match(/\/playlist\/([a-zA-Z0-9]+)/i);
        return listMatch ? listMatch[1] : '';
    } catch {
        return '';
    }
}

function buildSpotifyTrackUrl(trackId) {
    return `https://open.spotify.com/track/${trackId}`;
}

async function resolveSpotifyTrack(trackId) {
    const spotifyTrackUrl = buildSpotifyTrackUrl(trackId);
    const oEmbedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyTrackUrl)}`;

    const response = await axios.get(oEmbedUrl, { timeout: 30000 });
    const data = response.data || {};
    const title = (data.title || '').toString().trim();
    const artist = (data.author_name || '').toString().trim();

    if (!title) {
        throw new Error('Could not read track title from Spotify link.');
    }

    return {
        title,
        artist: artist || 'Unknown Artist',
        spotifyTrackUrl,
    };
}

async function ensureSpotifyAccessToken() {
    if (!spotifyApi) {
        throw new Error('Spotify playlist import requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in backend environment.');
    }

    if (spotifyAccessTokenExpiresAt && Date.now() < spotifyAccessTokenExpiresAt) {
        return;
    }

    const auth = await spotifyApi.clientCredentialsGrant();
    const accessToken = auth?.body?.access_token;
    const expiresIn = Number(auth?.body?.expires_in || 3600);

    if (!accessToken) {
        throw new Error('Failed to get Spotify API access token.');
    }

    spotifyApi.setAccessToken(accessToken);
    spotifyAccessTokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;
}

async function resolveSpotifyPlaylist(playlistId) {
    await ensureSpotifyAccessToken();

    let playlistName = '';
    try {
        const playlist = await spotifyApi.getPlaylist(playlistId, { fields: 'name' });
        playlistName = (playlist?.body?.name || '').toString().trim();
    } catch {
        // Non-fatal; we can still import tracks.
    }

    const entries = [];
    let offset = 0;
    const pageLimit = 100;

    while (entries.length < MAX_SPOTIFY_PLAYLIST_TRACKS) {
        const remaining = MAX_SPOTIFY_PLAYLIST_TRACKS - entries.length;
        const limit = Math.min(pageLimit, remaining);

        const page = await spotifyApi.getPlaylistTracks(playlistId, {
            offset,
            limit,
            fields: 'items(track(name,artists(name),external_urls,is_local)),next,total',
        });

        const items = page?.body?.items || [];
        if (!items.length) break;

        for (const item of items) {
            if (entries.length >= MAX_SPOTIFY_PLAYLIST_TRACKS) break;

            const track = item?.track;
            if (!track || track.is_local) continue;

            const title = (track.name || '').toString().trim();
            const artist = Array.isArray(track.artists)
                ? track.artists.map((a) => (a?.name || '').toString().trim()).filter(Boolean).join(', ')
                : '';

            if (!title) continue;

            entries.push({
                title,
                artist: artist || 'Unknown Artist',
                spotifyTrackUrl: track?.external_urls?.spotify || '',
            });
        }

        if (!page?.body?.next) break;
        offset += items.length;
    }

    if (!entries.length) {
        throw new Error('No importable tracks found in Spotify playlist.');
    }

    log(`Resolved ${entries.length} Spotify track(s). Matching YouTube sources…`);

    const mappedEntries = [];
    for (let i = 0; i < entries.length; i++) {
        const track = entries[i];
        const query = `${track.title} ${track.artist} official audio`;
        try {
            const youtubeUrl = await searchYouTubeUrl(query);
            mappedEntries.push({
                title: track.title,
                artist: track.artist,
                url: youtubeUrl,
                webpage_url: youtubeUrl,
                source: 'spotify',
                spotifyTrackUrl: track.spotifyTrackUrl,
            });
            log(`[Spotify ${i + 1}/${entries.length}] Matched: ${track.title}`);
        } catch (matchError) {
            warn(`[Spotify ${i + 1}/${entries.length}] Skipped (no YouTube match): ${track.title} — ${matchError.message}`);
        }
    }

    if (!mappedEntries.length) {
        throw new Error('Could not match any Spotify playlist tracks to YouTube sources.');
    }

    return {
        entries: mappedEntries,
        playlistAlbum: playlistName || '',
    };
}

async function searchYouTubeUrl(query) {
    const q = (query || '').toString().trim();
    if (!q) throw new Error('Search query is required.');

    try {
        const results = await play.search(q, { limit: 1, source: { youtube: 'video' } });
        const first = Array.isArray(results) ? results[0] : null;
        if (first?.url) return first.url;
    } catch {
        // Fallback to yt-dlp search below.
    }

    const searchInfo = await ytDlpExec(`ytsearch1:${q}`, {
        dumpSingleJson: true,
        skipDownload: true,
        quiet: true,
        noWarnings: true,
    });

    if (searchInfo?.webpage_url) return searchInfo.webpage_url;
    if (searchInfo?.id) return `https://www.youtube.com/watch?v=${searchInfo.id}`;
    throw new Error('No YouTube match found for this Spotify song.');
}

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

async function downloadAudioWithYtDlp(url, stem) {
    const outputTemplate = path.join(SONGS_DIR, `${stem}.%(ext)s`);
    const beforeFiles = new Set(await fs.readdir(SONGS_DIR));

    const ytdlpOptions = {
        noPlaylist: true,
        format: 'bestaudio/best',
        output: outputTemplate,
        quiet: true,
        noWarnings: true,
    };

    const cookiesPath = await getYtDlpCookiesFilePath();
    if (cookiesPath) {
        ytdlpOptions.cookies = cookiesPath;
    }

    await ytDlpExec(url, ytdlpOptions);

    const afterFiles = await fs.readdir(SONGS_DIR);
    const added = afterFiles
        .filter((file) => !beforeFiles.has(file) && file.startsWith(`${stem}.`))
        .filter((file) => !/\.(jpg|jpeg|png|webp)$/i.test(file));

    if (!added.length) {
        throw new Error('yt-dlp fallback completed but no audio file was created.');
    }

    const fileName = added[0];
    const ext = path.extname(fileName).replace('.', '') || 'bin';
    return {
        audioPath: path.join(SONGS_DIR, fileName),
        audioExt: ext,
    };
}

async function getVideoInfoWithYtDlp(url) {
    const ytdlpOptions = {
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
        quiet: true,
    };

    const cookiesPath = await getYtDlpCookiesFilePath();
    if (cookiesPath) {
        ytdlpOptions.cookies = cookiesPath;
    }

    return ytDlpExec(url, ytdlpOptions);
}

async function downloadEntry(url, stem) {
    const normalizedUrl = normalizeVideoUrl(url);
    const useYtdlpPrimary = PREFER_YTDLP;

    let info;
    let audioFormats = [];

    if (useYtdlpPrimary) {
        const ytdlpInfo = await getVideoInfoWithYtDlp(normalizedUrl);
        info = {
            video_details: {
                title: ytdlpInfo.title,
                artist: ytdlpInfo.artist,
                creator: ytdlpInfo.creator,
                uploader: ytdlpInfo.uploader,
                channel: { name: ytdlpInfo.channel || ytdlpInfo.uploader || '' },
                thumbnails: (ytdlpInfo.thumbnails || []).map((thumb) => ({ url: thumb.url })),
            },
            format: [],
        };
    } else {
        info = await play.video_info(normalizedUrl);
        audioFormats = (info.format || [])
            .filter((format) => typeof format.mimeType === 'string' && format.mimeType.startsWith('audio/') && format.url)
            .sort((left, right) => (Number(right.bitrate || right.averageBitrate || 0) - Number(left.bitrate || left.averageBitrate || 0)));
    }

    let audioExt;
    let audioPath;

    try {
        if (useYtdlpPrimary) {
            const fallback = await downloadAudioWithYtDlp(normalizedUrl, stem);
            audioPath = fallback.audioPath;
            audioExt = fallback.audioExt;
        } else if (audioFormats.length) {
            const selectedFormat = audioFormats[0];
            const selectedFormatUrl = toAbsoluteHttpUrl(selectedFormat.url);
            if (!selectedFormatUrl) {
                throw new Error('No usable direct audio URL in selected format.');
            }
            audioExt = extensionFromMimeType(selectedFormat.mimeType);
            audioPath = path.join(SONGS_DIR, `${stem}.${audioExt}`);

            const audioResponse = await axios.get(selectedFormatUrl, {
                responseType: 'stream',
                timeout: 120000,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
            await streamToFile(audioResponse.data, audioPath);
        } else {
            const streamedAudio = await play.stream(normalizedUrl, { quality: 2 });
            audioExt = extensionFromStreamType(streamedAudio.type);
            audioPath = path.join(SONGS_DIR, `${stem}.${audioExt}`);
            await streamToFile(streamedAudio.stream, audioPath);
        }
    } catch (primaryError) {
        warn(`Primary downloader failed (${primaryError.message}). Trying yt-dlp fallback...`);
        const fallback = await downloadAudioWithYtDlp(normalizedUrl, stem);
        audioPath = fallback.audioPath;
        audioExt = fallback.audioExt;
    }

    const thumbnailUrl = toAbsoluteHttpUrl(info.video_details?.thumbnails?.at(-1)?.url);
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
    const spotifyTrackId = parseSpotifyTrackId(playlistUrl);
    if (spotifyTrackId) {
        log('Spotify track link detected. Resolving metadata…');
        const track = await resolveSpotifyTrack(spotifyTrackId);
        const query = `${track.title} ${track.artist} official audio`;
        const youtubeUrl = await searchYouTubeUrl(query);
        log(`Matched Spotify track to YouTube source: ${youtubeUrl}`);
        return {
            entries: [{
                title: track.title,
                artist: track.artist,
                url: youtubeUrl,
                webpage_url: youtubeUrl,
                source: 'spotify',
                spotifyTrackUrl: track.spotifyTrackUrl,
            }],
            playlistAlbum: '',
        };
    }

    const spotifyPlaylistId = parseSpotifyPlaylistId(playlistUrl);
    if (spotifyPlaylistId) {
        log('Spotify playlist link detected. Resolving tracks via Spotify API…');
        return resolveSpotifyPlaylist(spotifyPlaylistId);
    }

    log('Fetching playlist info (this may take a moment)…');
    try {
        const normalizedPlaylistUrl = normalizePlaylistUrl(playlistUrl);
        const playlist = await play.playlist_info(normalizedPlaylistUrl, { incomplete: true });
        const entries = await playlist.all_videos();
        log(`Found ${entries.length} track(s) in playlist.`);
        const playlistAlbum = (playlist?.title || '').toString().trim();
        return {
            entries,
            playlistAlbum: !playlistAlbum || /^uploads|mix$/i.test(playlistAlbum) ? '' : playlistAlbum,
        };
    } catch (playlistError) {
        const normalizedVideoUrl = normalizeVideoUrl(playlistUrl);
        const videoInfo = await play.video_basic_info(normalizedVideoUrl);
        log('Input is not a playlist. Falling back to single-video import.');
        return { entries: [videoInfo.video_details], playlistAlbum: '' };
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n\x1b[35m╔═══════════════════════════════════════╗');
    console.log('║    Soul Sound — Music Importer Tool   ║');
    console.log('╚═══════════════════════════════════════╝\x1b[0m\n');

    let token;
    try {
        const authResult = await getToken();
        token = typeof authResult === 'string' ? authResult : authResult.token;

        let userRole = typeof authResult === 'string' ? '' : authResult.role;
        if (!userRole) {
            try {
                const me = await axios.get(`${API_BASE}/api/auth/me`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                userRole = me.data?.data?.role || '';
            } catch {
                // ignore; upload endpoints will still enforce permissions
            }
        }

        if (userRole && userRole !== 'admin') {
            err(`Authenticated user is role "${userRole}", not admin.`);
            warn('Importer requires an admin account because artist/song creation endpoints are admin-only.');
            process.exit(1);
        }

        ok('Authenticated.');
    } catch (e) {
        err(`Auth failed: ${e.response?.data?.message || e.message}`);
        warn(`Importer API base: ${API_BASE}`);
        process.exit(1);
    }

    let entries;
    let playlistAlbum = '';
    try {
        const playlistResult = await getPlaylistEntries(PLAYLIST_URL);
        entries = playlistResult.entries;
        playlistAlbum = playlistResult.playlistAlbum || '';
    } catch (e) {
        err(`Failed to resolve import source: ${e.message}`);
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

        const resolvedAlbum = extractAlbumName(info, extractAlbumName(entry, playlistAlbum)) || playlistAlbum || '';
        if (resolvedAlbum) {
            log(`Album:  ${resolvedAlbum}`);
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
            err(`Artist lookup/creation failed: ${e.response?.status || ''} ${e.response?.data?.message || e.message}`.trim());
            summary.failed++;
            continue;
        }

        // ── Step 5: upload ─────────────────────────────────────────────────
        log('Uploading to API…');
        try {
            const form = new FormData();
            form.append('title', refreshedMeta.title || title);
            form.append('artistId', artistId);
            if (resolvedAlbum) {
                form.append('album', resolvedAlbum);
            }
            form.append('audio', fs.createReadStream(audioPath), `${stem}.${audioExt}`);
            if (hasCover && fs.existsSync(jpgPath)) {
                form.append('coverImage', fs.createReadStream(jpgPath), `${stem}.jpg`);
            }

            try {
                await fs.writeJson(path.join(META_DIR, `${stem}.json`), {
                    title: refreshedMeta.title || title,
                    artist: refreshedMeta.artist || artist,
                    album: resolvedAlbum || '',
                    genre: '',
                }, { spaces: 2 });
            } catch (metaErr) {
                warn(`Could not write metadata for ${stem}: ${metaErr.message}`);
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
            err(`Upload failed: ${e.response?.status || ''} ${e.response?.data?.message || e.message}`.trim());
            summary.failed++;
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n\x1b[35m╔═══════════════ DONE ════════════════╗\x1b[0m');
    ok(`Uploaded : ${summary.success}`);
    summary.skipped && warn(`Skipped  : ${summary.skipped} (duplicates)`);
    summary.failed && err(`Failed   : ${summary.failed}`);
    console.log('\x1b[35m╚═════════════════════════════════════╝\x1b[0m\n');

    if (summary.failed > 0) {
        process.exit(1);
    }
}

main().catch(e => {
    err(`Fatal: ${e.message}`);
    process.exit(1);
});
