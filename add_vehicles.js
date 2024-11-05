// Import required libraries
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGO_DB, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', function () {
  console.log('Connected to the database');
});

// Create a vehicle schema
const vehicleSchema = new mongoose.Schema({
  carName: String,
  year: Number,
  make: String,
  model: String,
  vin: String,
  dailyPrice: Number,
  status: String,
});

// Create a model from the schema
const Vehicle = mongoose.model('Vehicle', vehicleSchema);

// Function to generate random VIN
function generateRandomVin() {
  return uuidv4().replace(/-/g, '').substring(0, 17).toUpperCase();
}

// Vehicles to be added to the database
const vehicles = [
  {
    carName: 'Tesla Model 3',
    year: 2023,
    make: 'Tesla',
    model: 'Model 3',
    vin: generateRandomVin(),
    dailyPrice: 99,
    status: 'Active',
  },
  {
    carName: 'Tesla Model Y',
    year: 2023,
    make: 'Tesla',
    model: 'Model Y',
    vin: generateRandomVin(),
    dailyPrice: 119,
    status: 'Active',
  },
  {
    carName: 'Tesla Model S',
    year: 2023,
    make: 'Tesla',
    model: 'Model S',
    vin: generateRandomVin(),
    dailyPrice: 139,
    status: 'Active',
  },
];

// Insert vehicles into the database
Vehicle.insertMany(vehicles)
  .then((docs) => {
    console.log('Vehicles successfully added:', docs);
    mongoose.connection.close();
  })
  .catch((err) => {
    console.error('Error adding vehicles:', err);
    mongoose.connection.close();
  });
