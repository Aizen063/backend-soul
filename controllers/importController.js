const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

/**
 * In-memory job store  { [jobId]: { status, logs[], startedAt } }
 * Fine for a single-admin CLI-style tool; no persistence needed.
 */
const jobs = {};

let jobCounter = 0;

const resolveImporterScriptPath = () => {
    const candidates = [
        path.join(__dirname, '../tools/music-importer/autoImport.js'),
        path.join(__dirname, '../../tools/music-importer/autoImport.js'),
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
};

const getImporterBaseDir = () => {
    const scriptPath = resolveImporterScriptPath();
    if (!scriptPath) return null;
    return path.dirname(scriptPath);
};

const getImporterDownloadsDir = () => {
    if (process.env.IMPORT_DOWNLOAD_DIR) return process.env.IMPORT_DOWNLOAD_DIR;
    if (process.env.VERCEL) return path.join(os.tmpdir(), 'soul-sound-importer', 'downloads');
    const importerBaseDir = getImporterBaseDir();
    if (!importerBaseDir) return null;
    return path.join(importerBaseDir, 'downloads');
};

/**
 * @desc  Start a playlist import job
 * @route POST /api/admin/import
 * @body  { playlistUrl: string }
 */
const startImport = (req, res) => {
    const { playlistUrl } = req.body;
    if (!playlistUrl) {
        return res.status(400).json({ success: false, message: 'playlistUrl is required' });
    }

    if (process.env.VERCEL) {
        return res.status(503).json({
            success: false,
            message: 'YouTube import is not supported on Vercel. YouTube is challenging the serverless runtime as a bot. Run the importer on your local machine or deploy the backend to a VPS/worker host.',
        });
    }

    const jobId = `job-${++jobCounter}-${Date.now()}`;
    jobs[jobId] = { status: 'running', logs: [], startedAt: new Date().toISOString() };

    // Build the token from the current authenticated user's JWT header
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    const scriptPath = resolveImporterScriptPath();
    if (!scriptPath) {
        return res.status(500).json({
            success: false,
            message: 'Importer script not found in deployment. Ensure tools/music-importer/autoImport.js is included in backend build output.',
        });
    }

    // Spawn as a child process so the response returns immediately
    const child = spawn(
        process.execPath, // same node binary
        [scriptPath, playlistUrl, '--token', token, '--api', `http://localhost:${process.env.PORT || 5000}`],
        {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                IMPORT_DOWNLOAD_DIR: process.env.IMPORT_DOWNLOAD_DIR || path.join(os.tmpdir(), 'soul-sound-importer', 'downloads'),
            },
        }
    );

    const pushLog = (type, data) => {
        const line = data.toString().trim();
        if (!line) return;
        line.split('\n').forEach(l => {
            jobs[jobId].logs.push({ type, msg: l.replace(/\x1b\[[0-9;]*m/g, '') }); // strip ANSI
        });
    };

    child.stdout.on('data', d => pushLog('info', d));
    child.stderr.on('data', d => pushLog('error', d));

    child.on('close', code => {
        jobs[jobId].status = code === 0 ? 'done' : 'failed';
        jobs[jobId].exitCode = code;
        jobs[jobId].finishedAt = new Date().toISOString();
    });

    child.on('error', err => {
        jobs[jobId].logs.push({ type: 'error', msg: `Process error: ${err.message}` });
        jobs[jobId].status = 'failed';
    });

    return res.status(202).json({ success: true, jobId });
};

/**
 * @desc  Poll job status + logs
 * @route GET /api/admin/import/:jobId
 */
const getImportStatus = (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    return res.json({ success: true, ...job });
};

/**
 * @desc  List all import jobs (newest first)
 * @route GET /api/admin/import
 */
const listImports = (req, res) => {
    const list = Object.entries(jobs)
        .map(([id, j]) => ({ jobId: id, status: j.status, startedAt: j.startedAt, logCount: j.logs.length }))
        .reverse();
    return res.json({ success: true, data: list });
};

/**
 * @desc  List all audio files in the downloads folder (with matched covers)
 * @route GET /api/admin/import/downloads
 */
const listDownloads = (req, res) => {
    const downloadsDir = getImporterDownloadsDir();
    if (!downloadsDir) {
        return res.json({ success: true, data: [] });
    }
    const songsDir = path.join(downloadsDir, 'songs');
    const coversDir = path.join(downloadsDir, 'covers');
    const metadataDir = path.join(downloadsDir, 'metadata');

    if (!fs.existsSync(songsDir)) {
        return res.json({ success: true, data: [] });
    }

    const AUDIO_EXTS = ['.mp3', '.webm', '.ogg', '.flac', '.m4a', '.opus', '.wav', '.aac'];
    const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

    const audioFiles = fs.readdirSync(songsDir)
        .filter(f => AUDIO_EXTS.some(ext => f.toLowerCase().endsWith(ext)));

    // Build a lookup of covers by stem (strip extension)
    const coversByStem = {};
    if (fs.existsSync(coversDir)) {
        fs.readdirSync(coversDir).forEach(f => {
            const ext = path.extname(f).toLowerCase();
            if (IMAGE_EXTS.includes(ext)) {
                const stem = f.slice(0, f.length - ext.length);
                coversByStem[stem] = f;
            }
        });
    }
    // Also check songs dir for thumbnails that weren't moved
    fs.readdirSync(songsDir).forEach(f => {
        const ext = path.extname(f).toLowerCase();
        if (IMAGE_EXTS.includes(ext)) {
            const stem = f.slice(0, f.length - ext.length);
            if (!coversByStem[stem]) coversByStem[stem] = `__songs__/${f}`;
        }
    });

    const metadataByStem = {};
    if (fs.existsSync(metadataDir)) {
        fs.readdirSync(metadataDir)
            .filter((f) => f.toLowerCase().endsWith('.json'))
            .forEach((f) => {
                const stem = f.slice(0, -5);
                try {
                    const parsed = JSON.parse(fs.readFileSync(path.join(metadataDir, f), 'utf8'));
                    metadataByStem[stem] = {
                        album: (parsed?.album || '').toString().trim(),
                        genre: (parsed?.genre || '').toString().trim(),
                        artist: (parsed?.artist || '').toString().trim(),
                        title: (parsed?.title || '').toString().trim(),
                    };
                } catch {
                    // Ignore malformed metadata files
                }
            });
    }

    const data = audioFiles.map(filename => {
        const ext = path.extname(filename);
        const stem = filename.slice(0, filename.length - ext.length);

        let title = '';
        let artist = '';

        if (stem.includes('---')) {
            // Pattern 1: Explicit "artist---title" separator (written by autoImport)
            const parts = stem.split('---');
            artist = parts[0].replace(/-/g, ' ').trim();
            title = parts.slice(1).join(' ').replace(/-/g, ' ').trim();
        } else {
            // Pattern 2: Try common YouTube separators in the raw stem
            // e.g. "sabrina-carpenter---espresso" or "artist - title"
            const humanReadable = stem.replace(/-/g, ' ').replace(/\s{2,}/g, ' ').trim();

            // Try "Artist - Title", "Artist – Title", "Artist — Title", "Artist | Title"
            const sepMatch = humanReadable.match(/^(.+?)\s*[-–—|]\s+(.+)$/);
            if (sepMatch) {
                artist = sepMatch[1].trim();
                title = sepMatch[2].trim();
            } else {
                title = humanReadable;
            }
        }

        // Clean up common YouTube suffixes
        title = title
            .replace(/\s*\(?\s*(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?\s*video|audio)\s*\)?\s*/gi, '')
            .replace(/\s*\[?\s*(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?\s*video|audio)\s*\]?\s*/gi, '')
            .replace(/\s*\|\s*$/, '')
            .trim();

        // Capitalise words
        const cap = s => s.replace(/\b\w/g, c => c.toUpperCase());
        title = cap(title);
        artist = cap(artist);

        const coverFile = coversByStem[stem] || null;
        const meta = metadataByStem[stem] || null;

        return {
            filename,
            stem,
            ext: ext.replace('.', ''),
            coverFile,
            title: meta?.title || title,
            artist: meta?.artist || artist,
            album: meta?.album || '',
            genre: meta?.genre || '',
        };
    });

    return res.json({ success: true, count: data.length, data });
};

/**
 * @desc  Delete all files in the downloads folder
 * @route DELETE /api/admin/import/downloads
 */
const clearDownloads = (req, res) => {
    const downloadsDir = getImporterDownloadsDir();
    if (!downloadsDir) {
        return res.json({ success: true, message: 'Importer directory not found.', deleted: 0 });
    }
    const dirs = [
        path.join(downloadsDir, 'songs'),
        path.join(downloadsDir, 'covers'),
        path.join(downloadsDir, 'metadata'),
    ];

    let deleted = 0;
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
            try { fs.unlinkSync(path.join(dir, file)); deleted++; } catch { }
        }
    }

    return res.json({ success: true, message: `Cleared ${deleted} file(s) from downloads folder.`, deleted });
};

const ffmpegConvertToMp3 = (inputPath, outputPath) => {
    const { spawnSync } = require('child_process');
    console.log(`[import] Converting to MP3: ${path.basename(inputPath)}...`);

    const result = spawnSync('ffmpeg', [
        '-y',               // overwrite output
        '-i', inputPath,
        '-vn',              // strip video
        '-c:a', 'libmp3lame', // explicit mp3 codec
        '-q:a', '2',          // high quality variable bitrate
        outputPath,
    ], { timeout: 120_000 });

    if (result.status !== 0) {
        const errMsg = (result.stderr || result.stdout || Buffer.from([])).toString().slice(-400);
        console.error(`[import] ffmpeg failed for ${path.basename(inputPath)}:`, errMsg);
        throw new Error(`ffmpeg failed (code ${result.status}): ${errMsg}`);
    }
    console.log(`[import] Conversion successful: ${path.basename(outputPath)}`);
    return outputPath;
};

/**
 * @desc  Bulk-upload songs from the downloads folder into the DB
 * @route POST /api/admin/import/upload-downloads
 * @body  { songs: [{ filename, coverFile, title, artistId, album, genre }] }
 */
const uploadDownloads = async (req, res) => {
    const os = require('os');
    const FormData = require('form-data');
    const axios = require('axios');

    const { songs } = req.body;
    if (!Array.isArray(songs) || !songs.length) {
        return res.status(400).json({ success: false, message: 'songs array is required' });
    }

    const downloadsDir = getImporterDownloadsDir();
    if (!downloadsDir) {
        return res.status(500).json({ success: false, message: 'Importer directory not found in deployment.' });
    }

    const songsDir = path.join(downloadsDir, 'songs');
    const coversDir = path.join(downloadsDir, 'covers');

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const apiBase = `http://localhost:${process.env.PORT || 5000}`;

    const created = [];
    const errors = [];

    const Artist = require('../models/Artist');

    for (let i = 0; i < songs.length; i++) {
        const { filename, coverFile, title, artistId, artistName, album, genre } = songs[i];
        const audioPath = path.join(songsDir, filename);

        // Cover can be in covers/ dir or (if prefixed __songs__/) in the songs dir itself
        let jpgPath = null;
        if (coverFile) {
            if (coverFile.startsWith('__songs__/')) {
                jpgPath = path.join(songsDir, coverFile.replace('__songs__/', ''));
            } else {
                jpgPath = path.join(coversDir, coverFile);
            }
        }

        if (!fs.existsSync(audioPath)) {
            errors.push({ index: i, title, error: `File not found: ${filename}` });
            continue;
        }

        // Resolve artist: use supplied artistId OR find/create by name
        let resolvedArtistId = artistId;
        if (!resolvedArtistId && artistName?.trim()) {
            try {
                let artist = await Artist.findOne({ name: new RegExp(`^${artistName.trim()}$`, 'i') });
                if (!artist) {
                    artist = await Artist.create({ name: artistName.trim() });
                }
                resolvedArtistId = artist._id.toString();
            } catch (e) {
                errors.push({ index: i, title, error: `Could not create artist "${artistName}": ${e.message}` });
                continue;
            }
        }

        if (!resolvedArtistId) {
            errors.push({ index: i, title, error: 'Artist name or ID is required' });
            continue;
        }

        let tempMp3 = null; // track temp file for cleanup
        try {
            let uploadAudioPath = audioPath;
            let uploadFilename = filename;

            // Convert non-mp3 files to mp3 so the browser can play them
            const ext = path.extname(filename).toLowerCase();
            if (ext !== '.mp3') {
                const stem = path.basename(filename, ext);
                tempMp3 = path.join(os.tmpdir(), `import-${Date.now()}-${stem}.mp3`);
                try {
                    ffmpegConvertToMp3(audioPath, tempMp3);
                    uploadAudioPath = tempMp3;
                    uploadFilename = stem + '.mp3';
                } catch (convertErr) {
                    // ffmpeg not installed or failed — upload the original and let the browser try
                    console.warn(`[import] ffmpeg conversion failed for "${filename}": ${convertErr.message}`);
                    tempMp3 = null; // nothing to clean up
                }
            }

            const form = new FormData();
            form.append('title', title);
            form.append('artistId', resolvedArtistId);
            if (album) form.append('album', album);
            if (genre) form.append('genre', genre);
            form.append('audio', fs.createReadStream(uploadAudioPath), uploadFilename);
            if (jpgPath && fs.existsSync(jpgPath)) {
                const coverBasename = path.basename(jpgPath);
                form.append('coverImage', fs.createReadStream(jpgPath), coverBasename);
            }

            const uploadRes = await axios.post(`${apiBase}/api/songs`, form, {
                headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });

            created.push(uploadRes.data.data);
        } catch (err) {
            errors.push({ index: i, title, error: err.response?.data?.message || err.message });
        } finally {
            // Clean up temp mp3 if we created one
            if (tempMp3 && fs.existsSync(tempMp3)) {
                try { fs.unlinkSync(tempMp3); } catch { }
            }
        }
    }

    return res.status(201).json({
        success: true,
        created: created.length,
        failed: errors.length,
        data: created,
        errors,
    });
};

module.exports = { startImport, getImportStatus, listImports, listDownloads, uploadDownloads, clearDownloads };
