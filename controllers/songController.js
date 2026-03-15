const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Song = require('../models/Song');
const Artist = require('../models/Artist');
const User = require('../models/User');

const buildFileUrl = (req, file) => {
    return file.path; // For Cloudinary, file.path is the full asset URL
};

/**
 * Helper: delete a file from the uploads directory using its stored URL
 * Note: Cloudinary asset deletion is omitted here for simplicity,
 * but handles local fallback cleanup safely.
 */
const deleteUploadedFile = (url) => {
    if (!url) return;
    try {
        if (url.includes('cloudinary.com')) {
           // Skip local deletion for cloudinary URLs
           return;
        }
        const filename = url.split('/uploads/').pop();
        if (!filename) return;
        const filePath = path.join(__dirname, '..', 'uploads', filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore cleanup errors */ }
};

/**
 * @desc    Upload a new song (Admin only)
 * @route   POST /api/songs
 * @access  Private/Admin
 */
const createSong = async (req, res) => {
    const { title, artistId, album, genre, lyrics } = req.body;

    if (!title || !artistId) {
        return res.status(400).json({ success: false, message: 'Title and artistId are required.' });
    }

    // Verify artist exists
    const artist = await Artist.findById(artistId);
    if (!artist) {
        return res.status(404).json({ success: false, message: 'Artist not found.' });
    }

    if (!req.files || !req.files['audio']) {
        return res.status(400).json({ success: false, message: 'Audio file is required.' });
    }

    const audioUrl = buildFileUrl(req, req.files['audio'][0]);
    const coverImage = req.files['coverImage']
        ? buildFileUrl(req, req.files['coverImage'][0])
        : '';

    const song = await Song.create({
        title,
        artist: artistId,
        album: album || 'Unknown Album',
        genre: genre || 'Unknown Genre',
        lyrics: lyrics || '',
        audioUrl,
        coverImage,
        uploadedBy: req.user._id,
    });

    await song.populate('artist', 'name photo genre');

    return res.status(201).json({
        success: true,
        message: 'Song uploaded successfully.',
        data: song,
    });
};

/**
 * @desc    Get all songs
 * @route   GET /api/songs
 * @access  Public
 */
const getAllSongs = async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const q = (req.query.q || '').toString().trim();
    const genre = (req.query.genre || '').toString().trim();
    const includeUploader = req.query.includeUploader === 'true';
    const skip = (page - 1) * limit;

    const filter = {};

    if (genre && genre.toLowerCase() !== 'all') {
        filter.genre = genre;
    }

    if (q) {
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        const matchingArtists = await Artist.find({ name: regex }).select('_id');
        const artistIds = matchingArtists.map((a) => a._id);
        filter.$or = [
            { title: regex },
            { album: regex },
            { genre: regex },
            { artist: { $in: artistIds } },
        ];
    }

    let songsQuery = Song.find(filter)
        .populate('artist', 'name photo genre')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

    if (includeUploader) {
        songsQuery = songsQuery.populate('uploadedBy', 'name email');
    }

    const [songs, total] = await Promise.all([
        songsQuery,
        Song.countDocuments(filter),
    ]);

    return res.status(200).json({
        success: true,
        count: songs.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        data: songs,
    });
};

/**
 * @desc    Search songs (optimized for search UI)
 * @route   GET /api/songs/search
 * @access  Public
 */
const searchSongs = async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const genre = (req.query.genre || '').toString().trim();
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const filter = {};

    if (genre && genre.toLowerCase() !== 'all') {
        filter.genre = genre;
    }

    if (q) {
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        const matchingArtists = await Artist.find({ name: regex }).select('_id');
        const artistIds = matchingArtists.map((a) => new mongoose.Types.ObjectId(a._id));
        filter.$or = [
            { title: regex },
            { album: regex },
            { genre: regex },
            { artist: { $in: artistIds } },
        ];
    }

    const [songs, total] = await Promise.all([
        Song.find(filter)
            .populate('artist', 'name photo genre')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Song.countDocuments(filter),
    ]);

    return res.status(200).json({
        success: true,
        count: songs.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        data: songs,
    });
};

/**
 * @desc    Get a single song by ID
 * @route   GET /api/songs/:id
 * @access  Public
 */
const getSongById = async (req, res) => {
    const song = await Song.findById(req.params.id)
        .populate('artist', 'name photo genre bio')
        .populate('uploadedBy', 'name email');

    if (!song) {
        return res.status(404).json({ success: false, message: 'Song not found.' });
    }
    return res.status(200).json({ success: true, data: song });
};

/**
 * @desc    Update a song (Admin only)
 * @route   PUT /api/songs/:id
 * @access  Private/Admin
 */
const updateSong = async (req, res) => {
    const song = await Song.findById(req.params.id);
    if (!song) {
        return res.status(404).json({ success: false, message: 'Song not found.' });
    }

    const { title, artistId, album, genre, lyrics } = req.body;
    if (title) song.title = title;
    if (album !== undefined) song.album = album;
    if (genre !== undefined) song.genre = genre;
    if (lyrics !== undefined) song.lyrics = lyrics;

    if (artistId) {
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return res.status(404).json({ success: false, message: 'Artist not found.' });
        }
        song.artist = artistId;
    }

    if (req.files && req.files['audio']) {
        deleteUploadedFile(song.audioUrl); // clean up old file
        song.audioUrl = buildFileUrl(req, req.files['audio'][0]);
    }
    if (req.files && req.files['coverImage']) {
        deleteUploadedFile(song.coverImage); // clean up old file
        song.coverImage = buildFileUrl(req, req.files['coverImage'][0]);
    }

    await song.save();
    await song.populate('artist', 'name photo genre');

    return res.status(200).json({
        success: true,
        message: 'Song updated successfully.',
        data: song,
    });
};

/**
 * @desc    Delete a song (Admin only)
 * @route   DELETE /api/songs/:id
 * @access  Private/Admin
 */
const deleteSong = async (req, res) => {
    const song = await Song.findById(req.params.id);
    if (!song) {
        return res.status(404).json({ success: false, message: 'Song not found.' });
    }

    // Clean up associated files from disk
    deleteUploadedFile(song.audioUrl);
    deleteUploadedFile(song.coverImage);

    // Remove from all users' likedSongs arrays
    await User.updateMany(
        { likedSongs: song._id },
        { $pull: { likedSongs: song._id } }
    );

    await song.deleteOne();
    return res.status(200).json({ success: true, message: 'Song deleted successfully.' });
};

/**
 * @desc    Bulk upload songs (Admin only)
 * @route   POST /api/songs/bulk
 * @access  Private/Admin
 *
 * Body (multipart/form-data):
 *   audio[]        – audio files (required, up to 20)
 *   coverImage[]   – cover images (optional, matched by index)
 *   titles[]       – song title per index
 *   artistIds[]    – artist ObjectId per index
 *   albums[]       – album name per index (optional)
 *   genres[]       – genre per index (optional)
 */
const bulkCreateSongs = async (req, res) => {
    const audioFiles = req.files?.['audio'] || [];
    const coverFiles = req.files?.['coverImage'] || [];

    if (!audioFiles.length) {
        return res.status(400).json({ success: false, message: 'At least one audio file is required.' });
    }

    // Body arrays – Express parses repeated keys as arrays automatically
    const titles = [].concat(req.body['titles[]'] || req.body.titles || []);
    const artistIds = [].concat(req.body['artistIds[]'] || req.body.artistIds || []);
    const albums = [].concat(req.body['albums[]'] || req.body.albums || []);
    const genres = [].concat(req.body['genres[]'] || req.body.genres || []);

    const created = [];
    const errors = [];

    for (let i = 0; i < audioFiles.length; i++) {
        const title = titles[i] || `Untitled ${i + 1}`;
        const artistId = artistIds[i] || null;
        const album = albums[i] || 'Unknown Album';
        const genre = genres[i] || 'Unknown Genre';

        try {
            if (!artistId) throw new Error('artistId is required');

            const artist = await Artist.findById(artistId);
            if (!artist) throw new Error(`Artist not found: ${artistId}`);

            const audioUrl = buildFileUrl(req, audioFiles[i]);
            const coverImage = coverFiles[i] ? buildFileUrl(req, coverFiles[i]) : '';

            const song = await Song.create({
                title,
                artist: artistId,
                album,
                genre,
                audioUrl,
                coverImage,
                uploadedBy: req.user._id,
            });

            await song.populate('artist', 'name photo genre');
            created.push(song);
        } catch (err) {
            errors.push({ index: i, title, error: err.message });
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

/**
 * @desc    Bulk delete songs by IDs (Admin only)
 * @route   DELETE /api/songs/bulk
 * @access  Private/Admin
 * @body    { ids: string[] }
 */
const bulkDeleteSongs = async (req, res) => {
    const { ids } = req.body;

    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ success: false, message: 'ids array is required.' });
    }

    const songs = await Song.find({ _id: { $in: ids } });

    // Delete associated files from disk
    for (const song of songs) {
        deleteUploadedFile(song.audioUrl);
        deleteUploadedFile(song.coverImage);
    }

    // Remove from all users' likedSongs
    await User.updateMany(
        { likedSongs: { $in: ids } },
        { $pull: { likedSongs: { $in: ids } } }
    );

    const result = await Song.deleteMany({ _id: { $in: ids } });

    return res.status(200).json({
        success: true,
        message: `${result.deletedCount} song(s) deleted.`,
        deleted: result.deletedCount,
        notFound: ids.length - songs.length,
    });
};

module.exports = { createSong, getAllSongs, searchSongs, getSongById, updateSong, deleteSong, bulkCreateSongs, bulkDeleteSongs };
