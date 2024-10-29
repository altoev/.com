// Import required modules
const http = require('http');
const app = require('./app');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Set port
const PORT = process.env.PORT || 5000;

// Create server
const server = http.createServer(app);

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
