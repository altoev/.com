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
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

// Load environment variables
dotenv.config();

if (!process.env.PERSONA_API_KEY || !process.env.SIMPLE_TXT_API || !process.env.STRIPE_SECRET_KEY || !process.env.IMAP_USER || !process.env.IMAP_PASS || !process.env.IMAP_HOST || !process.env.MONGO_DB || !process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET || !process.env.PLAID_TEMPLATE_ID) {
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

// Define email schema
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

const ParsedEmail = mongoose.model('ParsedEmail', emailSchema);

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Plaid client setup
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

// Helper function to check and update reservation status
async function checkAndUpdateReservationStatus() {
  const now = moment().tz("America/New_York");
  const reservations = await ParsedEmail.find({ status: { $in: ['Booked', 'Ongoing'] } });

  for (const reservation of reservations) {
    if (reservation.startDateTime && moment(reservation.startDateTime).isBefore(now) && moment(reservation.endDateTime).isAfter(now)) {
      if (reservation.status !== 'Ongoing') {
        reservation.status = 'Ongoing';
        await reservation.save();
        console.log(`Reservation ${reservation.rentalNumber} marked as Ongoing.`);
      }
    } else if (reservation.endDateTime && moment(reservation.endDateTime).isBefore(now)) {
      reservation.status = 'Completed';
      await reservation.save();
      console.log(`Reservation ${reservation.rentalNumber} marked as Completed.`);
    }
  }
}

// Regularly check for reservations that need to be marked as Ongoing or Completed
setInterval(checkAndUpdateReservationStatus, 60000);

// Route to return the homepage
app.get('/', (req, res) => {
  res.send('Welcome to Altoev API');
});

// Generate reservation number route
app.post('/generate-reservation-number', (req, res) => {
  const reservationNumber = `AJAX-${Math.floor(100000000 + Math.random() * 900000000)}`;
  res.status(200).send({ reservationNumber });
});

// Plaid Identity Verification Route
app.post('/create-plaid-verification', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: `user-${Math.floor(Math.random() * 1000000000)}`,
      },
      client_name: "Altoev",
      products: ["identity_verification"],
      country_codes: ["US"],
      language: "en",
      identity_verification: {
        template_id: process.env.PLAID_TEMPLATE_ID,
      },
    });
    res.status(200).json({ link_token: response.data.link_token });
  } catch (error) {
    console.error('Error creating Plaid verification link:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.response ? error.response.data : error.message });
  }
});

// Stripe Create Verification Session Route
app.post('/stripe/create-verification-session', async (req, res) => {
  try {
    const verificationSession = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: {
        user_id: 'unique_user_id',
      },
      options: {
        document: {
          allowed_types: ['driving_license', 'passport', 'id_card'],
          require_id_number: true,
          require_matching_selfie: true,
        },
      },
    });

    res.status(200).json({ client_secret: verificationSession.client_secret });
  } catch (error) {
    console.error('Error creating Stripe verification session:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Stripe Public Key Route
app.get('/stripe-public-key', (req, res) => {
  res.send(process.env.STRIPE_PUBLISHABLE_KEY);
});

// Endpoint to process payment
app.post('/process-payment', async (req, res) => {
  const { token, amount } = req.body;

  try {
    const charge = await stripe.charges.create({
      amount,
      currency: 'usd',
      description: 'Car rental payment',
      source: token,
    });
    res.status(200).send({ success: true, charge });
  } catch (error) {
    console.error('Error processing payment:', error.message);
    res.status(500).json({ error: 'Payment failed. Please try again.' });
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

    const searchCriteria = ['UNSEEN', ['FROM', 'damian@altoev.com']];
    const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'], markSeen: true };

    console.log("Searching for new emails...");
    const messages = await connection.search(searchCriteria, fetchOptions);

    if (messages.length === 0) {
      console.log("No new emails found.");
    } else {
      console.log(`Found ${messages.length} new email(s).`);
    }

    for (const item of messages) {
      const subject = item.parts.find(part => part.which === 'HEADER.FIELDS (FROM TO SUBJECT DATE)').body.subject[0];
      const isBooking = subject.toLowerCase().includes("is booked");
      const isChange = subject.toLowerCase().includes("has changed");
      const isCancellation = /has cancelled.*trip with your/i.test(subject);

      if (!isBooking && !isChange && !isCancellation) {
        console.log("Skipping email as subject does not match booking, change, or cancellation.");
        continue;
      }

      const all = item.parts.find(part => part.which === 'TEXT');
      let emailContent = all.body;
      emailContent = quotedPrintable.decode(emailContent);

      const rentalNumberMatch = emailContent.match(/Reservation ID #(\d+)/i);
      const rentalNumber = rentalNumberMatch ? rentalNumberMatch[1] : null;

      if (isBooking && rentalNumber) {
        const datesMatch = emailContent.match(/booked from\s+(.+?)\s+(\d{1,2}:\d{2}\s?[ap]m)\s+to\s+(.+?)\s+(\d{1,2}:\d{2}\s?[ap]m)/i);
        if (!datesMatch) {
          console.warn("Date format not matched; skipping email.");
          continue;
        }
        
        const rentalDates = `${datesMatch[1]} ${datesMatch[2]} to ${datesMatch[3]} ${datesMatch[4]}`;
        const startDateTime = moment.tz(`${datesMatch[1]} ${datesMatch[2]}`, "dddd, MMMM D, YYYY h:mm A", "America/New_York").toDate();
        const endDateTime = moment.tz(`${datesMatch[3]} ${datesMatch[4]}`, "dddd, MMMM D, YYYY h:mm A", "America/New_York").toDate();

        if (!startDateTime || !endDateTime || isNaN(startDateTime) || isNaN(endDateTime)) {
          console.warn("Invalid date parsing, skipping email.");
          continue;
        }

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
            console.log(`Updated existing reservation ${rentalNumber} with new information.`);
          } else {
            console.log(`Duplicate email for reservation ${rentalNumber} with no new information, ignored.`);
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
          console.log(`Parsed Data saved to MongoDB -> Rental Number: ${rentalNumber}, Status: Booked`);
        }
      } else if (isChange && rentalNumber) {
        const changeMatch = emailContent.match(/Trip start:\s+([\d\/]+)\s+(\d{1,2}:\d{2}\s?[ap]m)\s+Trip end:\s+([\d\/]+)\s+(\d{1,2}:\d{2}\s?[ap]m)/i);
        if (!changeMatch) {
          console.warn("Date format not matched in change email; skipping.");
          continue;
        }

        const startDateTime = moment.tz(`${changeMatch[1]} ${changeMatch[2]}`, "M/D/YY h:mm A", "America/New_York").toDate();
        const endDateTime = moment.tz(`${changeMatch[3]} ${changeMatch[4]}`, "M/D/YY h:mm A", "America/New_York").toDate();

        const existingEmail = await ParsedEmail.findOne({ rentalNumber });
        if (existingEmail) {
          existingEmail.startDateTime = startDateTime;
          existingEmail.endDateTime = endDateTime;
          await existingEmail.save();
          console.log(`Updated reservation ${rentalNumber} with changed dates.`);
        } else {
          console.log(`No existing reservation found for change email with rental number ${rentalNumber}.`);
        }
      } else if (isCancellation && rentalNumber) {
        const cancelledEmail = await ParsedEmail.findOneAndUpdate(
          { rentalNumber },
          { status: 'Cancelled' },
          { new: true }
        );

        if (cancelledEmail) {
          console.log(`Reservation ${rentalNumber} marked as Cancelled in MongoDB.`);
        } else {
          console.log(`No reservation found for Rental Number: ${rentalNumber} to cancel.`);
        }
      }
    }

    connection.end();
  } catch (error) {
    console.error("Error fetching emails:", error);
  }
}

// Set an interval to check for new emails and update reservation statuses
setInterval(fetchEmails, 300000);
setInterval(checkAndUpdateReservationStatus, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  fetchEmails();
});

module.exports = app;
