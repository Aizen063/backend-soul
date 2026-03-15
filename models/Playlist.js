const mongoose = require('mongoose');

const playlistSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Playlist name is required'],
            trim: true,
            maxlength: [200, 'Playlist name cannot exceed 200 characters'],
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        songs: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Song',
            },
        ],
    },
    { timestamps: true }
);

module.exports = mongoose.model('Playlist', playlistSchema);
