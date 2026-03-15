const User = require('../models/User');
const Song = require('../models/Song');
const Artist = require('../models/Artist');
const Playlist = require('../models/Playlist');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

/**
 * @desc    Get all users (Admin only)
 * @route   GET /api/users
 * @access  Private/Admin
 */
const getAllUsers = async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
        User.find().select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit),
        User.countDocuments(),
    ]);

    return res.status(200).json({
        success: true,
        count: users.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        data: users,
    });
};

/**
 * @desc    Delete a user by ID (Admin only)
 * @route   DELETE /api/users/:id
 * @access  Private/Admin
 */
const deleteUser = async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Prevent admin from deleting themselves
    if (user._id.toString() === req.user._id.toString()) {
        return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }

    await user.deleteOne();
    return res.status(200).json({ success: true, message: 'User deleted successfully.' });
};

/**
 * @desc    Update current user's profile
 * @route   PUT /api/users/profile
 * @access  Private
 */
const updateProfile = async (req, res) => {
    const { name, email, currentPassword } = req.body;

    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (name) user.name = name;

    // Email change requires current password for security
    if (email && email !== user.email) {
        if (!currentPassword) {
            return res.status(400).json({ success: false, message: 'Current password is required to change email.' });
        }
        const isMatch = await user.matchPassword(currentPassword);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
        }
        user.email = email;
    }

    // If an image was uploaded via multer, save its Cloudinary URL
    if (req.file) {
        user.profilePic = req.file.path;
    }

    await user.save();

    return res.status(200).json({
        success: true,
        message: 'Profile updated successfully.',
        data: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            profilePic: user.profilePic,
        },
    });
};

/**
 * @desc    Like or unlike a song
 * @route   PUT /api/users/like/:songId
 * @access  Private
 */
const toggleLikeSong = async (req, res) => {
    const user = await User.findById(req.user._id);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const songId = req.params.songId;

    // Validate the song actually exists
    const songExists = await Song.findById(songId);
    if (!songExists) {
        return res.status(404).json({ success: false, message: 'Song not found.' });
    }

    const alreadyLiked = user.likedSongs.some((id) => id.toString() === songId);

    if (alreadyLiked) {
        user.likedSongs = user.likedSongs.filter((id) => id.toString() !== songId);
        await user.save();
        return res.status(200).json({ success: true, message: 'Song unliked.', liked: false });
    } else {
        user.likedSongs.push(songId);
        await user.save();
        return res.status(200).json({ success: true, message: 'Song liked.', liked: true });
    }
};

/**
 * @desc    Get liked songs of current user
 * @route   GET /api/users/liked
 * @access  Private
 */
const getLikedSongs = async (req, res) => {
    const user = await User.findById(req.user._id).populate('likedSongs');
    return res.status(200).json({
        success: true,
        count: user.likedSongs.length,
        data: user.likedSongs,
    });
};

/**
 * @desc    Get recently played songs for the current user
 * @route   GET /api/users/history
 * @access  Private
 */
const getHistory = async (req, res) => {
    const user = await User.findById(req.user._id).populate({
        path: 'recentlyPlayed.song',
        populate: { path: 'artist', select: 'name' }
    });

    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    return res.status(200).json({
        success: true,
        count: user.recentlyPlayed.length,
        data: user.recentlyPlayed,
    });
};

/**
 * @desc    Add a song to the user's listening history
 * @route   POST /api/users/history
 * @access  Private
 */
const addToHistory = async (req, res) => {
    const { songId } = req.body;
    if (!songId) {
        return res.status(400).json({ success: false, message: 'Song ID is required.' });
    }

    if (!mongoose.Types.ObjectId.isValid(songId)) {
        return res.status(400).json({ success: false, message: 'Invalid Song ID format.' });
    }

    const songExists = await Song.exists({ _id: songId });
    if (!songExists) {
        return res.status(404).json({ success: false, message: 'Song not found.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Remove the song if it already exists in the history (to avoid duplicates, move it to front)
    user.recentlyPlayed = user.recentlyPlayed.filter((item) => {
        if (!item?.song) return false;
        return item.song.toString() !== songId;
    });

    // Add to the front of the array
    user.recentlyPlayed.unshift({ song: songId, playedAt: Date.now() });

    // Keep only the last 20 songs
    if (user.recentlyPlayed.length > 20) {
        user.recentlyPlayed = user.recentlyPlayed.slice(0, 20);
    }

    await user.save();

    return res.status(200).json({
        success: true,
        message: 'Song added to history.',
    });
};

/**
 * @desc    Change current user's password
 * @route   PUT /api/users/change-password
 * @access  Private
 */
const changePassword = async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Please provide current and new password.' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    await user.save();

    return res.status(200).json({ success: true, message: 'Password changed successfully.' });
};

/**
 * @desc    Get real platform analytics for admin dashboard
 * @route   GET /api/users/admin/stats
 * @access  Private/Admin
 */
const getAdminStats = async (req, res) => {
    const [userCount, songCount, artistCount, playlistCount] = await Promise.all([
        User.countDocuments(),
        Song.countDocuments(),
        Artist.countDocuments(),
        Playlist.countDocuments(),
    ]);

    // Genre distribution from songs
    const genreDistRaw = await Song.aggregate([
        { $group: { _id: '$genre', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
    ]);
    const genreDistribution = genreDistRaw.map(g => ({ genre: g._id || 'Unknown', count: g.count }));

    // User growth – last 6 months
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const [userGrowthRaw, usersBefore] = await Promise.all([
        User.aggregate([
            { $match: { createdAt: { $gte: sixMonthsAgo } } },
            { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, newUsers: { $sum: 1 } } },
            { $sort: { '_id.year': 1, '_id.month': 1 } },
        ]),
        User.countDocuments({ createdAt: { $lt: sixMonthsAgo } }),
    ]);

    let running = usersBefore;
    const userGrowth = userGrowthRaw.map(entry => {
        running += entry.newUsers;
        return {
            date: `${entry._id.year}-${String(entry._id.month).padStart(2, '0')}`,
            newUsers: entry.newUsers,
            totalUsers: running,
        };
    });

    // Song upload trend – last 6 months
    const songUploadRaw = await Song.aggregate([
        { $match: { createdAt: { $gte: sixMonthsAgo } } },
        { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, songs: { $sum: 1 } } },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);
    const songUploadTrend = songUploadRaw.map(e => ({
        date: `${e._id.year}-${String(e._id.month).padStart(2, '0')}`,
        songs: e.songs,
    }));

    // Top liked songs across all users
    const topLiked = await User.aggregate([
        { $unwind: '$likedSongs' },
        { $group: { _id: '$likedSongs', likeCount: { $sum: 1 } } },
        { $sort: { likeCount: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'songs', localField: '_id', foreignField: '_id', as: 'song' } },
        { $unwind: { path: '$song', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'artists', localField: 'song.artist', foreignField: '_id', as: 'artist' } },
        { $unwind: { path: '$artist', preserveNullAndEmptyArrays: true } },
    ]);
    const topLikedSongs = topLiked.map(item => ({
        songId: item._id,
        songTitle: item.song?.title || 'Unknown',
        artistName: item.artist?.name || 'Unknown Artist',
        likeCount: item.likeCount,
    }));

    // Storage used
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    let storageBytes = 0;
    if (fs.existsSync(uploadsDir)) {
        try {
            for (const f of fs.readdirSync(uploadsDir)) {
                const stat = fs.statSync(path.join(uploadsDir, f));
                if (stat.isFile()) storageBytes += stat.size;
            }
        } catch { /* ignore */ }
    }

    return res.status(200).json({
        success: true,
        data: {
            totalUsers: userCount,
            totalSongs: songCount,
            totalArtists: artistCount,
            totalPlaylists: playlistCount,
            storageUsedGB: parseFloat((storageBytes / (1024 * 1024 * 1024)).toFixed(3)),
            genreDistribution,
            userGrowth,
            songUploadTrend,
            topLikedSongs,
        },
    });
};

module.exports = { getAllUsers, deleteUser, updateProfile, toggleLikeSong, getLikedSongs, getHistory, addToHistory, changePassword, getAdminStats };
