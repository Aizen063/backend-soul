const mongoose = require('mongoose');

const songSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: [true, 'Song title is required'],
            trim: true,
            maxlength: [200, 'Title cannot exceed 200 characters'],
            index: true,
        },
        // artist now references the Artist model
        artist: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Artist',
            required: [true, 'Artist is required'],
            index: true,
        },
        album: {
            type: String,
            trim: true,
            default: 'Unknown Album',
        },
        genre: {
            type: String,
            trim: true,
            default: 'Unknown Genre',
        },
        audioUrl: {
            type: String,
            required: [true, 'Audio file URL is required'],
        },
        coverImage: {
            type: String,
            default: '',
        },
        uploadedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        lyrics: {
            type: String,
            default: '',
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Song', songSchema);
