const express = require('express');
const router = express.Router();
const {
    createPlaylist,
    getPlaylists,
    getAllPlaylistsAdmin,
    addSongToPlaylist,
    removeSongFromPlaylist,
    deletePlaylist,
    reorderPlaylist,
} = require('../controllers/playlistController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/roleMiddleware');

router.get('/admin/all', protect, adminOnly, getAllPlaylistsAdmin);
router.post('/', protect, createPlaylist);
router.get('/', protect, getPlaylists);
router.post('/:playlistId/add/:songId', protect, addSongToPlaylist);
router.delete('/:playlistId/remove/:songId', protect, removeSongFromPlaylist);
router.delete('/:playlistId', protect, deletePlaylist);
router.put('/:playlistId/reorder', protect, reorderPlaylist);

module.exports = router;
