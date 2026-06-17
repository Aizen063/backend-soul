#!/usr/bin/env node
/**
 * autoImport.js — YouTube & Spotify → Soul Sound Backend Importer
 *
 * Usage:
 *   node tools/music-importer/autoImport.js "URL" [--token JWT] [--api http://localhost:5000]
 *
 * Supported URL types:
 *   - YouTube playlist:  https://www.youtube.com/playlist?list=...
 *   - YouTube video:     https://www.youtube.com/watch?v=...  or  https://youtu.be/...
 *   - Spotify track:     https://open.spotify.com/track/...
 *   - Spotify album:     https://open.spotify.com/album/...
 *   - Spotify playlist:  https://open.spotify.com/playlist/...
 *
 * Auth:
 *   Pass --token <JWT>  OR set IMPORT_TOKEN in .env
 *   If omitted you will be prompted for admin email/password.
 *
 * Spotify (optional — enables metadata + album art):
 *   Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.import
 *   Get free credentials at https://developer.spotify.com/dashboard
 *   Without credentials the importer still works via YouTube search.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs-extra');

const { spawn } = require('child_process');

const axios = require('axios');
const FormData = require('form-data');
const play = require('play-dl');
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
        const m = parsed.pathname.match(/\/track\/([a-zA-Z0-9]+)/i);
        return m ? m[1] : '';
    } catch { return ''; }
}

function parseSpotifyAlbumId(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const input = rawUrl.trim();
    const uriMatch = input.match(/^spotify:album:([a-zA-Z0-9]+)$/i);
    if (uriMatch) return uriMatch[1];
    if (!input.startsWith('http://') && !input.startsWith('https://')) return '';
    try {
        const parsed = new URL(input);
        if (!/spotify\.com$/i.test(parsed.hostname)) return '';
        const m = parsed.pathname.match(/\/album\/([a-zA-Z0-9]+)/i);
        return m ? m[1] : '';
    } catch { return ''; }
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
        const m = parsed.pathname.match(/\/playlist\/([a-zA-Z0-9]+)/i);
        return m ? m[1] : '';
    } catch { return ''; }
}

// ─── Spotify Web API client (Client Credentials — no user login needed) ───────
let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

async function getSpotifyAccessToken() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;

    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await axios.post(
        'https://accounts.spotify.com/api/token',
        'grant_type=client_credentials',
        { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    _spotifyToken = res.data.access_token;
    _spotifyTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return _spotifyToken;
}

async function spotifyGet(endpoint) {
    const token = await getSpotifyAccessToken();
    if (!token) throw new Error('No Spotify credentials. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.import');
    const res = await axios.get(`https://api.spotify.com/v1${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    return res.data;
}

/** Convert a Spotify track object to an importer entry. */
function spotifyTrackToEntry(track, albumName = '', albumCoverUrl = '') {
    const artists = (track.artists || []).map(a => a.name).join(', ') || 'Unknown Artist';
    const album = track.album?.name || albumName || '';
    const images = track.album?.images || [];
    const coverUrl = images[0]?.url || albumCoverUrl || '';
    return {
        title: track.name || 'Unknown',
        artist: artists,
        album,
        coverUrl,
        source: 'spotify',
        // These fields tell the main loop to skip downloadEntry and use searchAndDownload
        isSpotify: true,
    };
}

/** Fetch a single Spotify track and return an entries array. */
async function getSpotifyTrackEntries(trackId) {
    log('Fetching Spotify track metadata…');
    const track = await spotifyGet(`/tracks/${trackId}`);
    return { entries: [spotifyTrackToEntry(track)], playlistAlbum: '' };
}

/** Fetch all tracks from a Spotify album. */
async function getSpotifyAlbumEntries(albumId) {
    log('Fetching Spotify album metadata…');
    const album = await spotifyGet(`/albums/${albumId}`);
    const albumName = album.name || '';
    const coverUrl = album.images?.[0]?.url || '';

    const entries = (album.tracks?.items || []).map(track => {
        const artists = (track.artists || []).map(a => a.name).join(', ') || 'Unknown Artist';
        return { title: track.name, artist: artists, album: albumName, coverUrl, source: 'spotify', isSpotify: true };
    });
    log(`Found ${entries.length} track(s) in album "${albumName}".`);
    return { entries, playlistAlbum: albumName };
}

/** Fetch all tracks from a Spotify playlist (handles pagination). */
async function getSpotifyPlaylistEntries(playlistId) {
    log('Fetching Spotify playlist metadata…');
    const playlist = await spotifyGet(`/playlists/${playlistId}?fields=name,images,tracks(items(track(name,artists,album(name,images))),next)`);
    const playlistName = playlist.name || '';

    let items = playlist.tracks?.items || [];
    let nextUrl = playlist.tracks?.next;

    // Paginate through all tracks
    while (nextUrl) {
        const token = await getSpotifyAccessToken();
        const res = await axios.get(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
        items = items.concat(res.data.items || []);
        nextUrl = res.data.next;
    }

    const entries = items
        .filter(item => item?.track)
        .map(item => spotifyTrackToEntry(item.track));

    log(`Found ${entries.length} track(s) in playlist "${playlistName}".`);
    return { entries, playlistAlbum: playlistName };
}

/**
 * Search YouTube for a Spotify track and download audio + cover.
 * Uses yt-dlp's built-in ytsearch: to find the best match.
 */
async function searchAndDownloadSpotify(entry, stem) {
    const query = `${entry.artist} - ${entry.title}`;
    log(`Searching YouTube: "${query}"`);

    // Use ytsearch1: to get the top result
    const searchUrl = `ytsearch1:${query}`;

    const ytdlpInfoOptions = {
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
        quiet: true,
        jsRuntimes: 'node',
        noPlaylist: true,
    };
    const cookiesPath = await getYtDlpCookiesFilePath();
    if (cookiesPath) ytdlpInfoOptions.cookies = cookiesPath;

    let ytInfo;
    try {
        ytInfo = await ytDlpExec(searchUrl, ytdlpInfoOptions);
        // ytsearch returns a playlist-like object; actual video is in entries[0]
        const videoInfo = ytInfo.entries?.[0] ?? ytInfo;
        log(`Found: "${videoInfo.title}" by ${videoInfo.uploader || videoInfo.channel || '?'}`);

        // Download the found video
        const videoUrl = videoInfo.webpage_url || `https://www.youtube.com/watch?v=${videoInfo.id}`;
        const { audioPath, audioExt } = await downloadAudioWithYtDlp(videoUrl, stem);

        // Cover: prefer Spotify's hi-res album art over YouTube thumbnail
        const jpgPath = path.join(COVERS_DIR, `${stem}.jpg`);
        let hasCover = false;

        if (entry.coverUrl) {
            try {
                await downloadThumbnailToJpg(entry.coverUrl, jpgPath);
                hasCover = true;
            } catch {
                // fall through to YouTube thumbnail
            }
        }

        if (!hasCover) {
            const thumbs = videoInfo.thumbnails || [];
            const thumbUrl = thumbs.at(-1)?.url || thumbs[0]?.url || '';
            if (thumbUrl) {
                try {
                    await downloadThumbnailToJpg(thumbUrl, jpgPath);
                    hasCover = true;
                } catch { /* no cover */ }
            }
        }

        return { audioPath, audioExt, jpgPath, hasCover };
    } catch (e) {
        throw new Error(`YouTube search/download failed for "${query}": ${e.message}`);
    }
}

const AUDIO_EXTS = ['.mp3', '.webm', '.ogg', '.flac', '.m4a', '.opus', '.wav', '.aac'];

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
        jsRuntimes: 'node',
    };

    const cookiesPath = await getYtDlpCookiesFilePath();
    if (cookiesPath) {
        ytdlpOptions.cookies = cookiesPath;
    }

    try {
        await ytDlpExec(url, ytdlpOptions);
    } catch (ytdlpError) {
        // yt-dlp sometimes exits non-zero even when the file was written.
        // Fall through to the file-scan check before re-throwing.
        warn(`yt-dlp exited with error: ${ytdlpError.message?.slice(0, 300)}`);
    }

    const afterFiles = await fs.readdir(SONGS_DIR);

    // First: prefer files that match the expected stem (exact output template match)
    const IMAGE_EXTS = /\.(jpg|jpeg|png|webp|gif)$/i;
    let added = afterFiles
        .filter((file) => !beforeFiles.has(file) && file.startsWith(`${stem}.`))
        .filter((file) => !IMAGE_EXTS.test(file));

    // Fallback: if stem didn't match (yt-dlp used its own title-based filename),
    // pick any new audio file that appeared in the directory.
    if (!added.length) {
        added = afterFiles
            .filter((file) => !beforeFiles.has(file))
            .filter((file) => !IMAGE_EXTS.test(file))
            .filter((file) => AUDIO_EXTS.some((ext) => file.toLowerCase().endsWith(ext)));

        if (added.length) {
            // Rename the file to match the expected stem so downstream code is consistent
            const originalName = added[0];
            const ext = path.extname(originalName);
            const renamedName = `${stem}${ext}`;
            try {
                await fs.rename(
                    path.join(SONGS_DIR, originalName),
                    path.join(SONGS_DIR, renamedName),
                );
                added[0] = renamedName;
            } catch {
                // Rename failed — proceed with the original filename
            }
        }
    }

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
        jsRuntimes: 'node',
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

    // Fetch video metadata — if play-dl rejects the URL, fall back to yt-dlp for info too
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
        try {
            info = await play.video_info(normalizedUrl);
            audioFormats = (info.format || [])
                .filter((format) => typeof format.mimeType === 'string' && format.mimeType.startsWith('audio/') && format.url)
                .sort((left, right) => (Number(right.bitrate || right.averageBitrate || 0) - Number(left.bitrate || left.averageBitrate || 0)));
        } catch (infoError) {
            // play-dl rejected the URL (e.g. "Invalid URL") — use yt-dlp for metadata too
            warn(`play-dl video_info failed (${infoError.message}). Using yt-dlp for metadata and download.`);
            try {
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
            } catch {
                // yt-dlp info also failed — set a minimal stub so download can still proceed
                info = { video_details: { thumbnails: [] }, format: [] };
            }
            audioFormats = []; // force yt-dlp download path below
        }
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

// ─── Resolve import source ────────────────────────────────────────────────────
async function getPlaylistEntries(playlistUrl) {
    const spotifyTrackId = parseSpotifyTrackId(playlistUrl);
    const spotifyAlbumId = parseSpotifyAlbumId(playlistUrl);
    const spotifyPlaylistId = parseSpotifyPlaylistId(playlistUrl);

    if (spotifyTrackId || spotifyAlbumId || spotifyPlaylistId) {
        const hasCredentials = !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
        if (!hasCredentials) {
            warn('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set in .env.import.');
            warn('Spotify metadata will be parsed from the URL only. For full metadata add credentials.');
            warn('Get free credentials at https://developer.spotify.com/dashboard');
        }

        if (spotifyTrackId) {
            if (hasCredentials) return getSpotifyTrackEntries(spotifyTrackId);
            // No credentials — build a minimal entry from the URL itself;
            // the title/artist will be resolved after YouTube search
            return { entries: [{ title: '', artist: '', album: '', coverUrl: '', source: 'spotify', isSpotify: true, spotifyTrackId }], playlistAlbum: '' };
        }
        if (spotifyAlbumId) {
            if (hasCredentials) return getSpotifyAlbumEntries(spotifyAlbumId);
            throw new Error('Spotify album import requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in .env.import');
        }
        if (spotifyPlaylistId) {
            if (hasCredentials) return getSpotifyPlaylistEntries(spotifyPlaylistId);
            throw new Error('Spotify playlist import requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in .env.import');
        }
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
        const rawVideoUrl = entry.url || entry.webpage_url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : '') || PLAYLIST_URL;
        const videoUrl = normalizeVideoUrl(rawVideoUrl);
        const rawTitle = entry.title || `Track ${i + 1}`;

        console.log(`\n─── [${i + 1}/${entries.length}] ${rawTitle} ───`);

        // ── Step 1: determine meta from flat info ──────────────────────────
        const { title, artist } = entry.isSpotify
            ? { title: entry.title || `Track ${i + 1}`, artist: entry.artist || 'Unknown Artist' }
            : extractMeta(entry);
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
        let info = { video_details: entry };
        let audioPath = '';
        let audioExt = '';
        let jpgPath = '';
        let hasCover = false;

        if (entry.isSpotify) {
            // ── Spotify path: search YouTube for this track ────────────────
            log(`Searching & downloading: ${title}`);
            try {
                const result = await searchAndDownloadSpotify(entry, stem);
                audioPath = result.audioPath;
                audioExt = result.audioExt;
                jpgPath = result.jpgPath;
                hasCover = result.hasCover;
            } catch (e) {
                err(`Download failed: ${e.message}`);
                summary.failed++;
                continue;
            }
        } else {
            // ── YouTube path ───────────────────────────────────────────────
            log(`Downloading: ${title}`);
            let downloadResult;
            try {
                downloadResult = await downloadEntry(videoUrl, stem);
            } catch (e) {
                err(`Download failed: ${e.message}`);
                summary.failed++;
                continue;
            }
            info = downloadResult.info;
            audioPath = downloadResult.audioPath;
            audioExt = downloadResult.audioExt;
            jpgPath = downloadResult.jpgPath;
            hasCover = downloadResult.hasCover;
        }

        if (!fs.existsSync(audioPath)) {
            err(`Audio not found at expected path: ${audioPath}`);
            summary.failed++;
            continue;
        }

        const refreshedMeta = entry.isSpotify
            ? { title: entry.title || title, artist: entry.artist || artist }
            : extractMeta(info.video_details || entry);
        if (refreshedMeta.title && refreshedMeta.title !== title) {
            log(`Resolved title: ${refreshedMeta.title}`);
        }
        if (refreshedMeta.artist && refreshedMeta.artist !== artist) {
            log(`Resolved artist: ${refreshedMeta.artist}`);
        }

        const resolvedAlbum = entry.isSpotify
            ? (entry.album || playlistAlbum || '')
            : (extractAlbumName(info, extractAlbumName(entry, playlistAlbum)) || playlistAlbum || '');
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
