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

// Load environment variables
dotenv.config();

if (!process.env.PERSONA_API_KEY || !process.env.SIMPLE_TXT_API || !process.env.STRIPE_SECRET_KEY || !process.env.IMAP_USER || !process.env.IMAP_PASS || !process.env.IMAP_HOST || !process.env.MONGO_DB) {
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
  status: { type: String, default: 'Valid' } // Adding status field with default "Valid"
});

const ParsedEmail = mongoose.model('ParsedEmail', emailSchema);

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Route to return the homepage
app.get('/', (req, res) => {
  res.send('Welcome to Altoev API');
});

// Generate a unique reservation number
function generateUniqueReservationNumber() {
  let reservationNumber;
  do {
    reservationNumber = `AJAX-${Math.floor(100000000 + Math.random() * 900000000)}`;
  } while (reservations[reservationNumber]);
  return reservationNumber;
}

// Generate reservation number route
app.post('/generate-reservation-number', (req, res) => {
  const reservationNumber = generateUniqueReservationNumber();
  reservations[reservationNumber] = { status: 'in-progress' };
  res.status(200).send({ reservationNumber });
});

// Persona Identity Verification Route
app.post('/persona-api/create-identity-verification', async (req, res) => {
  try {
    const { inquiryTemplateId } = req.body;
    if (!inquiryTemplateId) {
      return res.status(400).send({ error: 'Missing required field: inquiryTemplateId' });
    }

    const response = await axios.post('https://withpersona.com/api/v1/inquiries', {
      inquiry_template_id: inquiryTemplateId,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    res.status(200).send({ inquiry: response.data.data });
  } catch (error) {
    console.error('Error creating Persona inquiry:', error.message);
    res.status(500).send({ error: error.message });
  }
});

// SimpleTexting API Route to send SMS
app.post('/send-text', async (req, res) => {
  const { phoneNumber, reservationNumber, startDateTime, endDateTime } = req.body;

  if (!phoneNumber || !reservationNumber || !startDateTime || !endDateTime) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const message = `Thank you for booking with Altoev!\n\nReservation Number: ${reservationNumber}\nStart Date & Time: ${startDateTime}\nEnd Date & Time: ${endDateTime}\n\nIf you have any questions, don't hesitate to text us back here or email us at support@altoev.com`;

  try {
    const response = await axios.post('https://api-app2.simpletexting.com/v2/sms/send', {
      phone: phoneNumber,
      message: message,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.SIMPLE_TXT_API}`,
        'Content-Type': 'application/json',
      },
    });

    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    console.error('Error sending text message:', error.message);
    res.status(500).json({ error: error.message });
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

// Canopy Insurance Verification Route
app.post('/canopy-verification', (req, res) => {
  res.send('Canopy insurance verification process');
});

// Stripe Public Key Route
app.get('/stripe-public-key', (req, res) => {
  res.send(process.env.STRIPE_PUBLISHABLE_KEY);
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
      const isCancellation = /has cancelled.*trip with your/i.test(subject);

      if (!isBooking && !isCancellation) {
        console.log("Skipping email as subject does not match booking or cancellation.");
        continue;
      }

      const all = item.parts.find(part => part.which === 'TEXT');
      let emailContent = all.body;
      emailContent = quotedPrintable.decode(emailContent);

      const rentalNumberMatch = emailContent.match(/Reservation ID #(\d+)/i);
      const rentalNumber = rentalNumberMatch ? rentalNumberMatch[1] : null;

      if (isBooking && rentalNumber) {
        const datesMatch = emailContent.match(/booked from\s+(.+?)\s+(\d{1,2}:\d{2}\s?[ap]m)\s+to\s+(.+?)\s+(\d{1,2}:\d{2}\s?[ap]m)/i);
        const rentalDates = datesMatch ? `${datesMatch[1]} ${datesMatch[2]} to ${datesMatch[3]} ${datesMatch[4]}` : 'Not Found';
        const modelMatch = emailContent.match(/tesla\/(model-[3yxs])\/(\d{7})/i);
        const extractedNumber = modelMatch ? modelMatch[2] : 'Not Found';
        const model = modelMatch ? modelMatch[1] : 'Not Found';
        const customerNameMatch = emailContent.match(/About the guest\s+([\w\s]+)\n/);
        const customerName = customerNameMatch ? customerNameMatch[1].trim() : 'Not Found';
        const phoneNumberMatch = emailContent.match(/(\+\d{1,3}\s?\d{1,3}[\s-]?\d{3}[\s-]?\d{4})/);
        const customerPhone = phoneNumberMatch ? phoneNumberMatch[0].trim() : 'Not Found';

        const parsedEmail = new ParsedEmail({
          rentalNumber,
          rentalDates,
          model,
          extractedNumber,
          customerName,
          customerPhone,
          receivedDate: item.attributes.date,
          rawContent: emailContent,
          status: 'Valid'
        });

        await parsedEmail.save();
        console.log(`Parsed Data saved to MongoDB -> Rental Number: ${rentalNumber}, Status: Valid`);
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

// Set an interval to check for new emails every 5 minutes
setInterval(fetchEmails, 300000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  fetchEmails();
});

module.exports = app;
