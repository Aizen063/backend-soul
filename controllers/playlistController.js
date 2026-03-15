const Playlist = require('../models/Playlist');
const Song = require('../models/Song');

/**
 * @desc    Create a new playlist
 * @route   POST /api/playlists
 * @access  Private
 */
const createPlaylist = async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ success: false, message: 'Playlist name is required.' });
    }

    const playlist = await Playlist.create({
        name,
        user: req.user._id,
        songs: [],
    });

    return res.status(201).json({
        success: true,
        message: 'Playlist created successfully.',
        data: playlist,
    });
};

/**
 * @desc    Get all playlists for current user
 * @route   GET /api/playlists
 * @access  Private
 */
const getPlaylists = async (req, res) => {
    const playlists = await Playlist.find({ user: req.user._id })
        .populate({
            path: 'songs',
            populate: { path: 'artist', select: 'name' }
        })
        .sort({ createdAt: -1 });

    return res.status(200).json({
        success: true,
        count: playlists.length,
        data: playlists,
    });
};

/**
 * @desc    Add a song to a playlist
 * @route   POST /api/playlists/:playlistId/add/:songId
 * @access  Private
 */
const addSongToPlaylist = async (req, res) => {
    const playlist = await Playlist.findOne({
        _id: req.params.playlistId,
        user: req.user._id,
    });

    if (!playlist) {
        return res.status(404).json({ success: false, message: 'Playlist not found or not authorized.' });
    }

    const song = await Song.findById(req.params.songId);
    if (!song) {
        return res.status(404).json({ success: false, message: 'Song not found.' });
    }

    const alreadyAdded = playlist.songs.some(
        (id) => id.toString() === req.params.songId
    );

    if (alreadyAdded) {
        return res.status(409).json({ success: false, message: 'Song already in playlist.' });
    }

    playlist.songs.push(song._id);
    await playlist.save();

    return res.status(200).json({
        success: true,
        message: 'Song added to playlist.',
        data: playlist,
    });
};

/**
 * @desc    Remove a song from a playlist
 * @route   DELETE /api/playlists/:playlistId/remove/:songId
 * @access  Private
 */
const removeSongFromPlaylist = async (req, res) => {
    const playlist = await Playlist.findOne({
        _id: req.params.playlistId,
        user: req.user._id,
    });

    if (!playlist) {
        return res.status(404).json({ success: false, message: 'Playlist not found or not authorized.' });
    }

    playlist.songs = playlist.songs.filter(
        (id) => id.toString() !== req.params.songId
    );

    await playlist.save();

    return res.status(200).json({
        success: true,
        message: 'Song removed from playlist.',
        data: playlist,
    });
};

/**
 * @desc    Delete a playlist
 * @route   DELETE /api/playlists/:playlistId
 * @access  Private (owner or admin)
 */
const deletePlaylist = async (req, res) => {
    const isAdmin = req.user?.role === 'admin';
    const query = isAdmin
        ? { _id: req.params.playlistId }
        : { _id: req.params.playlistId, user: req.user._id };

    const playlist = await Playlist.findOne(query);

    if (!playlist) {
        return res.status(404).json({ success: false, message: 'Playlist not found or not authorized.' });
    }

    await playlist.deleteOne();
    return res.status(200).json({ success: true, message: 'Playlist deleted successfully.' });
};

/**
 * @desc    Reorder songs in a playlist
 * @route   PUT /api/playlists/:playlistId/reorder
 * @access  Private
 */
const reorderPlaylist = async (req, res) => {
    const { songIds } = req.body;
    
    if (!Array.isArray(songIds)) {
        return res.status(400).json({ success: false, message: 'songIds must be an array.' });
    }

    const playlist = await Playlist.findOne({
        _id: req.params.playlistId,
        user: req.user._id,
    });

    if (!playlist) {
        return res.status(404).json({ success: false, message: 'Playlist not found or not authorized.' });
    }

    playlist.songs = songIds;
    await playlist.save();

    return res.status(200).json({
        success: true,
        message: 'Playlist reordered successfully.',
        data: playlist,
    });
};

/**
 * @desc    Get ALL playlists across all users (Admin only)
 * @route   GET /api/playlists/admin/all
 * @access  Private/Admin
 */
const getAllPlaylistsAdmin = async (req, res) => {
    const playlists = await Playlist.find()
        .populate('user', 'name email')
        .populate({
            path: 'songs',
            populate: { path: 'artist', select: 'name' },
        })
        .sort({ createdAt: -1 });

    return res.status(200).json({
        success: true,
        count: playlists.length,
        data: playlists,
    });
};

module.exports = {
    createPlaylist,
    getPlaylists,
    getAllPlaylistsAdmin,
    addSongToPlaylist,
    removeSongFromPlaylist,
    deletePlaylist,
    reorderPlaylist,
};
