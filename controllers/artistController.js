const Artist = require('../models/Artist');
const Song = require('../models/Song');
const cloudinary = require('../config/cloudinary');

// Helper to build file URL
const buildFileUrl = (req, file) => file.path;

/**
 * Delete an asset from Cloudinary if it's a Cloudinary URL.
 */
const deleteAsset = async (url) => {
    if (!url || !url.includes('res.cloudinary.com')) return;
    try {
        const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
        if (!match) return;
        await cloudinary.uploader.destroy(match[1], { resource_type: 'image', invalidate: true });
    } catch { /* ignore cleanup errors */ }
};

/**
 * @desc    Create a new artist (Admin only)
 * @route   POST /api/artists
 * @access  Private/Admin
 */
const createArtist = async (req, res) => {
    const { name, bio, genre } = req.body;
    if (!name) {
        return res.status(400).json({ success: false, message: 'Artist name is required.' });
    }

    const photo = req.file ? buildFileUrl(req, req.file) : '';

    const artist = await Artist.create({ name, bio, genre, photo });

    return res.status(201).json({
        success: true,
        message: 'Artist created successfully.',
        data: artist,
    });
};

/**
 * @desc    Get all artists
 * @route   GET /api/artists
 * @access  Public
 */
const getAllArtists = async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [artists, total] = await Promise.all([
        Artist.find().sort({ name: 1 }).skip(skip).limit(limit),
        Artist.countDocuments(),
    ]);

    return res.status(200).json({
        success: true,
        count: artists.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        data: artists,
    });
};

/**
 * @desc    Get a single artist by ID
 * @route   GET /api/artists/:id
 * @access  Public
 */
const getArtistById = async (req, res) => {
    const artist = await Artist.findById(req.params.id);
    if (!artist) {
        return res.status(404).json({ success: false, message: 'Artist not found.' });
    }
    return res.status(200).json({ success: true, data: artist });
};

/**
 * @desc    Get all songs by artist ID
 * @route   GET /api/artists/:id/songs
 * @access  Public
 */
const getSongsByArtist = async (req, res) => {
    const artist = await Artist.findById(req.params.id);
    if (!artist) {
        return res.status(404).json({ success: false, message: 'Artist not found.' });
    }

    const songs = await Song.find({ artist: req.params.id })
        .populate('artist', 'name photo genre')
        .populate('uploadedBy', 'name email')
        .sort({ createdAt: -1 });

    return res.status(200).json({
        success: true,
        artist,
        count: songs.length,
        data: songs,
    });
};

/**
 * @desc    Update an artist (Admin only)
 * @route   PUT /api/artists/:id
 * @access  Private/Admin
 */
const updateArtist = async (req, res) => {
    const artist = await Artist.findById(req.params.id);
    if (!artist) {
        return res.status(404).json({ success: false, message: 'Artist not found.' });
    }

    const { name, bio, genre } = req.body;
    if (name) artist.name = name;
    if (bio !== undefined) artist.bio = bio;
    if (genre !== undefined) artist.genre = genre;
    if (req.file) {
        await deleteAsset(artist.photo); // remove old photo from Cloudinary
        artist.photo = buildFileUrl(req, req.file);
    }

    await artist.save();

    return res.status(200).json({
        success: true,
        message: 'Artist updated successfully.',
        data: artist,
    });
};

/**
 * @desc    Delete an artist (Admin only)
 * @route   DELETE /api/artists/:id
 * @access  Private/Admin
 */
const deleteArtist = async (req, res) => {
    const artist = await Artist.findById(req.params.id);
    if (!artist) {
        return res.status(404).json({ success: false, message: 'Artist not found.' });
    }

    // Prevent deletion if artist still has songs
    const songCount = await Song.countDocuments({ artist: req.params.id });
    if (songCount > 0) {
        return res.status(409).json({
            success: false,
            message: `Cannot delete artist with ${songCount} song(s). Delete or reassign songs first.`,
        });
    }

    await deleteAsset(artist.photo); // remove photo from Cloudinary
    await artist.deleteOne();
    return res.status(200).json({ success: true, message: 'Artist deleted successfully.' });
};

module.exports = {
    createArtist,
    getAllArtists,
    getArtistById,
    getSongsByArtist,
    updateArtist,
    deleteArtist,
};
