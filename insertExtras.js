// Import required modules
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

// MongoDB connection setup
mongoose.connect(process.env.MONGO_DB, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('Connected to MongoDB'))
  .catch((error) => console.error('Error connecting to MongoDB:', error));

// Define extras schema
const extraSchema = new mongoose.Schema({
  name: String,
  price: Number,
  priceType: String, // "daily" or "reservation"
  description: String,
});

const Extra = mongoose.model('Extra', extraSchema);

// Plans & Extras data
const extras = [
  {
    name: 'Supplemental Liability Insurance (SLI)',
    price: 29.99,
    priceType: 'daily',
    description: 'Provides additional liability coverage beyond what\'s included in the base rental. Protects you from third-party claims in case of an accident.',
  },
  {
    name: 'Supplemental Physical Damage Warranty (SPDW)',
    price: 49.99,
    priceType: 'daily',
    description: 'Covers the physical damage to the rental vehicle in the event of an accident, reducing the out-of-pocket expenses for repairs.',
  },
  {
    name: 'Personal Effects Insurance (PEI)',
    price: 9.99,
    priceType: 'daily',
    description: 'Protects your personal belongings in case of theft or damage while they are inside the rental car.',
  },
  {
    name: 'Unlimited Mileage',
    price: 49.99,
    priceType: 'daily',
    description: 'Allows you to drive unlimited miles without additional charges, perfect for long-distance trips.',
  },
  {
    name: 'Prepaid Recharge',
    price: 29.99,
    priceType: 'reservation',
    description: 'Covers the cost of refueling the vehicle before it is returned. Convenient option to avoid finding a gas station before drop-off.',
  },
];

// Insert extras into the database
async function insertExtras() {
  try {
    await Extra.insertMany(extras);
    console.log('Extras inserted successfully');
  } catch (error) {
    console.error('Error inserting extras:', error);
  } finally {
    mongoose.connection.close();
  }
}

insertExtras();
