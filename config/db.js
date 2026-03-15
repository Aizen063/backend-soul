const mongoose = require('mongoose');

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

const connectDB = async (retries = MAX_RETRIES) => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB connection error: ${error.message}`);
    if (retries > 0) {
      console.log(`🔄 Retrying in ${RETRY_DELAY_MS / 1000}s... (${retries} retries left)`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return connectDB(retries - 1);
    }
    console.error('💀 All MongoDB connection retries exhausted. Exiting.');
    process.exit(1);
  }
};

// Auto-reconnect on disconnect
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected. Attempting reconnect...');
  connectDB(3);
});

module.exports = connectDB;
