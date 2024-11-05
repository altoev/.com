// Import required modules
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const axios = require('axios');
const Stripe = require('stripe');
const Imap = require('imap-simple');
const quotedPrintable = require('quoted-printable');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const fs = require('fs');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

// Load environment variables
dotenv.config();

if (!process.env.SIMPLE_TXT_API || !process.env.STRIPE_SECRET_KEY || !process.env.IMAP_USER || !process.env.IMAP_PASS || !process.env.IMAP_HOST || !process.env.MONGO_DB || !process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET || !process.env.PLAID_TEMPLATE_ID) {
  console.error('Environment variables not set correctly. Check your .env file.');
  process.exit(1);
}

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// MongoDB connection setup
mongoose.connect(process.env.MONGO_DB, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('Connected to MongoDB'))
  .catch((error) => console.error('Error connecting to MongoDB:', error));

// Define schemas
const emailSchema = new mongoose.Schema({
  rentalNumber: String,
  rentalDates: String,
  model: String,
  extractedNumber: String,
  customerName: String,
  customerPhone: String,
  receivedDate: Date,
  rawContent: String,
  startDateTime: Date,
  endDateTime: Date,
  status: { type: String, default: 'Booked' }
});

const vehicleSchema = new mongoose.Schema({
  carName: String,
  year: Number,
  make: String,
  model: String,
  vin: String,
  dailyPrice: Number,
  status: String,
});

const reservationSchema = new mongoose.Schema({
  reservationNumber: { type: String, required: true, unique: true },
  startDate: Date,
  endDate: Date,
  vehicle: String,
  addons: Array,
  status: { type: String, default: 'Pending' },
  createdAt: { type: Date, default: Date.now },
  paymentIntentId: String,
  plaidVerificationData: Object,
  firstName: String,
  lastName: String,
  dob: String,
  licenseNumber: String,
  licenseExpirationDate: String,
  identityVerificationId: String,
  plaidLinkToken: String,
});

const extraSchema = new mongoose.Schema({
  name: String,
  price: Number,
  priceType: String,
  description: String,
});

const ParsedEmail = mongoose.model('ParsedEmail', emailSchema);
const Vehicle = mongoose.model('Vehicle', vehicleSchema);
const Reservation = mongoose.model('Reservation', reservationSchema);
const Extra = mongoose.model('Extra', extraSchema);

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to serve HTML files without .html extension
app.use((req, res, next) => {
  const requestedFile = path.join(__dirname, 'public', `${req.path}.html`);
  if (req.path !== '/' && !req.path.includes('.') && fs.existsSync(requestedFile)) {
    res.sendFile(requestedFile);
  } else {
    next();
  }
});

// Plaid client setup with production environment
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments.production,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
      'Plaid-Version': '2020-09-14',
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// Route to save/update reservation details
app.post('/api/save-reservation/:reservationId', async (req, res) => {
  try {
    const { reservationId } = req.params;
    const updateData = req.body;

    console.log(`Attempting to save/update reservation: ${reservationId}`);

    let reservation = await Reservation.findOne({ reservationNumber: reservationId });
    if (!reservation) {
      console.log(`Reservation ${reservationId} not found, creating a new one.`);
      reservation = new Reservation({ reservationNumber: reservationId, ...updateData });
    } else {
      console.log(`Reservation ${reservationId} found, updating it.`);
      Object.assign(reservation, updateData);
    }

    await reservation.save();
    console.log(`Reservation ${reservationId} saved/updated successfully.`);
    res.status(200).json({ message: 'Reservation updated successfully' });
  } catch (error) {
    console.error('Error saving/updating reservation:', error);
    if (error.name === 'ValidationError') {
      res.status(400).json({ error: 'Validation failed', details: error.errors });
    } else {
      res.status(500).json({ error: 'Failed to save/update reservation' });
    }
  }
});

// Plaid Identity Verification Route
app.post('/create-plaid-verification', async (req, res) => {
  const { reservationNumber } = req.body;

  try {
    console.log("Starting Plaid verification link creation...");

    let reservation = await Reservation.findOne({ reservationNumber });
    if (!reservation) {
      console.error(`Reservation ${reservationNumber} not found while creating Plaid verification.`);
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const response = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: reservationNumber,
      },
      client_name: "Altoev",
      products: ["identity_verification"],
      country_codes: ["US"],
      language: "en",
      identity_verification: {
        template_id: process.env.PLAID_TEMPLATE_ID,
      },
    });

    const linkToken = response.data.link_token;

    if (!linkToken) {
      throw new Error("Link token could not be created.");
    }

    reservation.plaidLinkToken = linkToken;

    await reservation.save();
    console.log(`Plaid link created successfully: ${linkToken}`);
    console.log(`Link token for reservation ${reservationNumber} saved successfully.`);

    res.status(200).json({ link_token: linkToken });
  } catch (error) {
    console.error('Error creating Plaid verification link:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.response ? error.response.data : error.message });
  }
});

// Webhook to receive Plaid identity verification completed event
app.post('/plaid-webhook', async (req, res) => {
  try {
    console.log("Received webhook:", JSON.stringify(req.body, null, 2));

    const { webhook_type, webhook_code, identity_verification_id, client_user_id } = req.body;

    if (webhook_type === 'IDENTITY_VERIFICATION' && webhook_code === 'VERIFICATION_COMPLETED') {
      console.log(`Webhook received for reservation: ${client_user_id} with verification ID: ${identity_verification_id}`);

      if (!identity_verification_id || !client_user_id) {
        console.error("Missing identity_verification_id or client_user_id in webhook payload.");
        return res.status(400).json({ error: 'Missing identity_verification_id or client_user_id in webhook payload' });
      }

      let reservation = await Reservation.findOneAndUpdate(
        { reservationNumber: client_user_id },
        { identityVerificationId: identity_verification_id },
        { new: true }
      );

      if (!reservation) {
        console.error(`Reservation ${client_user_id} not found while processing webhook.`);
        return res.status(404).json({ error: 'Reservation not found' });
      }

      console.log(`Verification ID saved successfully for reservation: ${client_user_id}`);
      res.status(200).json({ message: 'Verification ID saved successfully' });
    } else {
      console.warn(`Invalid webhook type or code received. webhook_type: ${webhook_type}, webhook_code: ${webhook_code}`);
      res.status(400).json({ message: 'Invalid webhook type or code' });
    }
  } catch (error) {
    console.error('Error processing Plaid webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Plaid Get Identity Verification Route
app.get('/api/get-verification-data/:reservationId', async (req, res) => {
  const { reservationId } = req.params;

  try {
    const reservation = await Reservation.findOne({ reservationNumber: reservationId });
    if (!reservation) {
      console.error(`Reservation ${reservationId} not found`);
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const verificationId = reservation.identityVerificationId;
    if (!verificationId) {
      console.error(`Verification ID for reservation ${reservationId} not found`);
      return res.status(404).json({ error: 'Verification ID not found in reservation data' });
    }

    console.log(`Fetching verification data from Plaid for ID: ${verificationId}...`);

    const response = await plaidClient.identityVerificationGet({
      identity_verification_id: verificationId,
    });

    const verificationData = response.data;

    if (!verificationData) {
      console.error(`Failed to fetch verification data for ID: ${verificationId}`);
      return res.status(500).json({ error: 'Failed to fetch verification data' });
    }

    console.log(`Received verification data:`, JSON.stringify(verificationData, null, 2));

    reservation.firstName = verificationData.user?.full_name?.split(" ")[0] || "N/A";
    reservation.lastName = verificationData.user?.full_name?.split(" ")[1] || "N/A";
    reservation.dob = verificationData.user?.date_of_birth || "N/A";
    reservation.licenseNumber = verificationData?.document_number || "N/A";
    reservation.licenseExpirationDate = verificationData?.expiry_date || "N/A";

    await reservation.save();

    console.log(`Verification data for ID: ${verificationId} saved successfully.`);
    res.status(200).json({ message: 'Verification data saved successfully', verificationData });
  } catch (error) {
    console.error('Error fetching Plaid verification data:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.response ? error.response.data : error.message });
  }
});

// Stripe Public Key Route
app.get('/stripe-public-key', (req, res) => {
  res.send(process.env.STRIPE_PUBLISHABLE_KEY);
});

// Endpoint to create a Payment Intent
app.post('/create-payment-intent', async (req, res) => {
  const { amount } = req.body;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      payment_method_types: ['card'],
    });

    res.status(200).send({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error('Error creating payment intent:', error.message);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

// Endpoint to confirm payment and finalize reservation
app.post('/confirm-payment', async (req, res) => {
  const { reservationId, paymentIntentId } = req.body;

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      const reservation = await Reservation.findOne({ reservationNumber: reservationId });
      if (reservation) {
        reservation.status = 'Confirmed';
        reservation.paymentIntentId = paymentIntentId;
        await reservation.save();
        res.status(200).json({ message: 'Reservation confirmed and payment successful' });
      } else {
        res.status(404).json({ error: 'Reservation not found' });
      }
    } else {
      res.status(400).json({ error: 'Payment not successful' });
    }
  } catch (error) {
    console.error('Error confirming payment:', error.message);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// Fetch parsed emails from MongoDB for the frontend
app.get('/parsed-emails', async (req, res) => {
  try {
    const emails = await ParsedEmail.find({});
    res.json(emails);
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).json({ error: 'Failed to retrieve emails' });
  }
});

// Fetch vehicles from MongoDB for the frontend
app.get('/api/vehicles', async (req, res) => {
  try {
    const vehicles = await Vehicle.find({ status: 'Active' });
    res.json(vehicles);
  } catch (err) {
    console.error('Error fetching vehicles:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Fetch extras from MongoDB for the frontend
app.get('/api/extras', async (req, res) => {
  try {
    const extras = await Extra.find({});
    res.json(extras);
  } catch (err) {
    console.error('Error fetching extras:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Endpoint to cancel a reservation by ID
app.post('/cancel-email/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await ParsedEmail.findByIdAndUpdate(id, { status: 'Cancelled' });
    res.status(200).json({ message: 'Reservation cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling reservation:', error);
    res.status(500).json({ error: 'Failed to cancel reservation' });
  }
});

// IMAP Configuration and Email Fetching
async function fetchEmails() {
  const config = {
    imap: {
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASS,
      host: process.env.IMAP_HOST,
      port: 993,
      tls: true,
      authTimeout: 3000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  try {
    console.log("Attempting to connect to IMAP...");
    const connection = await Imap.connect(config);
    console.log("Connected to IMAP server");

    await connection.openBox('INBOX');
    console.log("Inbox opened");

    const searchCriteria = ['UNSEEN', ['FROM', 'noreply@mail.turo.com']];
    const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'], markSeen: true };

    console.log("Searching for new emails...");
    const messages = await connection.search(searchCriteria, fetchOptions);

    for (const item of messages) {
      const subject = item.parts.find(part => part.which === 'HEADER.FIELDS (FROM TO SUBJECT DATE)').body.subject[0];
      const isBooking = subject.toLowerCase().includes("is booked");
      const isChange = subject.toLowerCase().includes("has changed");
      const isCancellation = /has cancelled.*trip with your/i.test(subject);

      if (!isBooking && !isChange && !isCancellation) continue;

      const all = item.parts.find(part => part.which === 'TEXT');
      let emailContent = all.body;
      emailContent = quotedPrintable.decode(emailContent);

      const rentalNumberMatch = emailContent.match(/Reservation ID #(\d+)/i);
      const rentalNumber = rentalNumberMatch ? rentalNumberMatch[1] : null;

      if (isBooking && rentalNumber) {
        const datesMatch = emailContent.match(/booked from\s+(.+?)\s+(\d{1,2}:\d{2}\s?[ap]m)\s+to\s+(.+?)\s+(\d{1,2}:\d{2}\s?[ap]m)/i);
        if (!datesMatch) continue;

        const rentalDates = `${datesMatch[1]} ${datesMatch[2]} to ${datesMatch[3]} ${datesMatch[4]}`;
        const startDateTime = moment.tz(`${datesMatch[1]} ${datesMatch[2]}`, "dddd, MMMM D, YYYY h:mm A", "America/New_York").toDate();
        const endDateTime = moment.tz(`${datesMatch[3]} ${datesMatch[4]}`, "dddd, MMMM D, YYYY h:mm A", "America/New_York").toDate();

        if (!startDateTime || !endDateTime || isNaN(startDateTime) || isNaN(endDateTime)) continue;

        const modelMatch = emailContent.match(/tesla\/(model-[3yxs])\/(\d{7})/i);
        const extractedNumber = modelMatch ? modelMatch[2] : 'Not Found';
        const model = modelMatch ? modelMatch[1] : 'Not Found';
        const customerNameMatch = emailContent.match(/About the guest\s+([\w\s]+)\n/);
        const customerName = customerNameMatch ? customerNameMatch[1].trim() : 'Not Found';
        const phoneNumberMatch = emailContent.match(/(\+\d{1,3}\s?\d{1,3}[\s-]?\d{3}[\s-]?\d{4})/);
        const customerPhone = phoneNumberMatch ? phoneNumberMatch[0].trim() : 'Not Found';

        const existingEmail = await ParsedEmail.findOne({ rentalNumber });
        if (existingEmail) {
          if (
            existingEmail.rentalDates !== rentalDates ||
            existingEmail.model !== model ||
            existingEmail.customerName !== customerName ||
            existingEmail.customerPhone !== customerPhone ||
            existingEmail.startDateTime.getTime() !== startDateTime.getTime() ||
            existingEmail.endDateTime.getTime() !== endDateTime.getTime()
          ) {
            existingEmail.rentalDates = rentalDates;
            existingEmail.model = model;
            existingEmail.extractedNumber = extractedNumber;
            existingEmail.customerName = customerName;
            existingEmail.customerPhone = customerPhone;
            existingEmail.receivedDate = item.attributes.date;
            existingEmail.rawContent = emailContent;
            existingEmail.startDateTime = startDateTime;
            existingEmail.endDateTime = endDateTime;
            await existingEmail.save();
          }
        } else {
          const parsedEmail = new ParsedEmail({
            rentalNumber,
            rentalDates,
            model,
            extractedNumber,
            customerName,
            customerPhone,
            receivedDate: item.attributes.date,
            rawContent: emailContent,
            startDateTime,
            endDateTime,
            status: 'Booked'
          });
          await parsedEmail.save();
        }
      } else if (isChange && rentalNumber) {
        const changeMatch = emailContent.match(/Trip start:\s+([\d\/]+)\s+(\d{1,2}:\d{2}\s?[ap]m)\s+Trip end:\s+([\d\/]+)\s+(\d{1,2}:\d{2}\s?[ap]m)/i);
        if (!changeMatch) continue;

        const startDateTime = moment.tz(`${changeMatch[1]} ${changeMatch[2]}`, "M/D/YY h:mm A", "America/New_York").toDate();
        const endDateTime = moment.tz(`${changeMatch[3]} ${changeMatch[4]}`, "M/D/YY h:mm A", "America/New York").toDate();

        const existingEmail = await ParsedEmail.findOne({ rentalNumber });
        if (existingEmail) {
          existingEmail.startDateTime = startDateTime;
          existingEmail.endDateTime = endDateTime;
          await existingEmail.save();
        }
      } else if (isCancellation && rentalNumber) {
        await ParsedEmail.findOneAndUpdate(
          { rentalNumber },
          { status: 'Cancelled' },
          { new: true }
        );
      }
    }

    connection.end();
  } catch (error) {
    console.error("Error fetching emails:", error);
  }
}

// Set an interval to check for new emails and update reservation statuses
setInterval(fetchEmails, 300000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
