const mongoose = require('mongoose');

const artistSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Artist name is required'],
            trim: true,
            maxlength: [200, 'Artist name cannot exceed 200 characters'],
        },
        bio: {
            type: String,
            trim: true,
            default: '',
        },
        photo: {
            type: String, // URL to uploaded photo
            default: '',
        },
        genre: {
            type: String,
            trim: true,
            default: '',
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Artist', artistSchema);
