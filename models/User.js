const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true,
            maxlength: [100, 'Name cannot exceed 100 characters'],
        },
        email: {
            type: String,
            required: [true, 'Email is required'],
            unique: true,
            lowercase: true,
            trim: true,
            match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
        },
        password: {
            type: String,
            required: [true, 'Password is required'],
            minlength: [6, 'Password must be at least 6 characters'],
            select: false,
        },
        role: {
            type: String,
            enum: ['user', 'admin'],
            default: 'user',
        },
        profilePic: {
            type: String,
            default: null,
        },
        likedSongs: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Song',
            },
        ],
        recentlyPlayed: [
            {
                song: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: 'Song',
                    required: true,
                },
                playedAt: {
                    type: Date,
                    default: Date.now,
                },
            },
        ],
        equalizerSettings: {
            bandsJson: {
                type: String,
                default: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            },
            preset: {
                type: String,
                default: 'Flat',
            },
            bass: {
                type: Number,
                default: 0,
            },
            mid: {
                type: Number,
                default: 0,
            },
            treble: {
                type: Number,
                default: 0,
            },
            updatedAt: {
                type: Date,
                default: Date.now,
            },
        },
    },
    { timestamps: true }
);

// Hash password before saving
// NOTE: In Mongoose 8+, async pre-hooks must NOT call next() — they signal
// completion by resolving the returned Promise.
userSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
});

// Compare entered password with hashed password
userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
