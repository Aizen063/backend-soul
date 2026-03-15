const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

// Configure Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    let folderName = 'soulsound/others';
    let resourceType = 'auto';

    if (file.mimetype.startsWith('image/')) {
      folderName = 'soulsound/images';
      resourceType = 'image';
    } else if (file.mimetype.startsWith('audio/')) {
      folderName = 'soulsound/audio';
      resourceType = 'video'; // Cloudinary treats audio as 'video' resource type
    } else if (file.mimetype.startsWith('video/')) {
      folderName = 'soulsound/video';
      resourceType = 'video';
    }

    return {
      folder: folderName,
      resource_type: resourceType,
    };
  },
});

// File filter – allow audio and image types
const fileFilter = (req, file, cb) => {
    const allowedAudio = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/webm', 'video/webm', 'audio/x-m4a', 'audio/aac', 'audio/opus'];
    const allowedImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const allowed = [...allowedAudio, ...allowedImage];

    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50 MB max per file
    },
});

// Preset: upload both audio and cover image fields
const uploadSongFiles = upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'coverImage', maxCount: 1 },
]);

// Preset: bulk upload — up to 20 audio + 20 cover images matched by index
const uploadBulkSongs = multer({
    storage,
    fileFilter,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file for bulk
}).fields([
    { name: 'audio', maxCount: 20 },
    { name: 'coverImage', maxCount: 20 },
]);

module.exports = { upload, uploadSongFiles, uploadBulkSongs };
