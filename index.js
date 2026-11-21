import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { randomBytes, createHmac } from "node:crypto";
import Stripe from "stripe";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";

const app = express();
const PORT = process.env.PORT || 5000;

const CLIENT_URL = (
  process.env.CLIENT_URL ||
  process.env.BETTER_AUTH_URL ||
  "http://localhost:3000"
).replace(/\/+$/, "");

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is missing in .env file");
}

if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error("BETTER_AUTH_SECRET is missing in .env file");
}

// Stripe setup (supports real test key or test mock mode)
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// MongoDB setup
const client = new MongoClient(process.env.MONGODB_URI);

let usersCol;
let servicesCol;
let bookingsCol;
let paymentsCol;

async function connectToMongoDB() {
  await client.connect();
  console.log("Successfully connected to MongoDB!");

  const database = client.db("mendizo");

  usersCol = database.collection("user");
  servicesCol = database.collection("services");
  bookingsCol = database.collection("bookings");
  paymentsCol = database.collection("payments");

  // Create unique index on payments to prevent duplicate payments
  await paymentsCol.createIndex(
    { stripeSessionId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        stripeSessionId: { $type: "string" },
      },
    }
  );

  await paymentsCol.createIndex(
    { bookingId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        bookingId: { $type: "string" },
      },
    }
  );

  console.log("MongoDB collections and indexes are ready!");
}

// Helper functions
function isValidObjectId(id) {
  return typeof id === "string" && /^[a-fA-F0-9]{24}$/.test(id);
}

function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  if (isValidObjectId(id)) return new ObjectId(id);
  return id;
}

async function findByIdOrString(collection, id) {
  if (!id) return null;
  if (id instanceof ObjectId) {
    return collection.findOne({ _id: id });
  }
  if (typeof id === "string" && isValidObjectId(id)) {
    const document = await collection.findOne({ _id: new ObjectId(id) });
    if (document) return document;
  }
  return collection.findOne({ _id: id });
}

// JWT verification helper using BetterAuth secret
function verifyJwtToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signature] = parts;
    const expectedSig = createHmac("sha256", process.env.BETTER_AUTH_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ROLE-BASED MIDDLEWARES (CHALLENGE 2)
// ───────────────────────────────────────────────────────────────────────────

export async function verifyToken(req, res, next) {
  try {
    // 1. Check Authorization Bearer header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const payload = verifyJwtToken(token);
      if (payload && payload.email) {
        const user = await usersCol.findOne({ email: payload.email });
        if (user) {
          req.user = {
            id: user.id || user._id.toString(),
            _id: user._id,
            email: user.email,
            name: user.name,
            role: user.role || "customer",
            image: user.image,
            phone: user.phone,
            area: user.area,
            bio: user.bio,
          };
          req.userId = req.user.id;
          return next();
        }
      }
    }

    // 2. Check BetterAuth Session (via cookie or headers)
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (session?.user) {
      // Fetch latest role and extra fields from users collection
      const dbUser = await usersCol.findOne({ email: session.user.email });
      const role = dbUser?.role || session.user.role || "customer";

      req.user = {
        ...session.user,
        role,
        id: session.user.id || dbUser?._id?.toString(),
        _id: dbUser?._id,
        phone: dbUser?.phone || session.user.phone || "",
        area: dbUser?.area || session.user.area || "",
        bio: dbUser?.bio || session.user.bio || "",
      };
      req.userId = req.user.id;
      return next();
    }

    return res.status(401).json({
      error: "Unauthorized. Please log in.",
    });
  } catch (error) {
    console.error("verifyToken error:", error);
    return res.status(401).json({
      error: "Unauthorized. Invalid or expired session.",
    });
  }
}

export function verifyCustomer(req, res, next) {
  if (req.user?.role !== "customer") {
    return res.status(403).json({
      error: "Forbidden. Customer account required.",
    });
  }
  next();
}

export function verifyTechnician(req, res, next) {
  if (req.user?.role !== "technician") {
    return res.status(403).json({
      error: "Forbidden. Technician account required.",
    });
  }
  next();
}

export function verifyAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      error: "Forbidden. Admin account required.",
    });
  }
  next();
}

// CORS setup
app.use(
  cors({
    origin: [CLIENT_URL, "http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
  })
);

// ───────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK (CHALLENGE 4) - Must be before express.json()
// ───────────────────────────────────────────────────────────────────────────
app.post(
  ["/api/stripe/webhook", "/api/payments/webhook"],
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured." });
    }

    const signature = req.headers["stripe-signature"];
    let event;

    if (process.env.STRIPE_WEBHOOK_SECRET && signature) {
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
    } else {
      try {
        event = JSON.parse(req.body.toString());
      } catch {
        return res.status(400).send("Invalid webhook payload.");
      }
    }

    if (event.type !== "checkout.session.completed") {
      return res.json({ received: true });
    }

    const session = event.data.object;
    if (session.payment_status !== "paid") {
      return res.json({ received: true });
    }

    try {
      const bookingId = session.metadata?.bookingId;
      const stripeSessionId = session.id;

      if (!bookingId) {
        return res.status(400).json({ error: "Missing bookingId in metadata." });
      }

      const booking = await findByIdOrString(bookingsCol, bookingId);
      if (!booking) {
        return res.status(404).json({ error: "Booking not found." });
      }

      // Check if payment is already recorded (prevent double payment)
      const existingPayment = await paymentsCol.findOne({
        $or: [{ stripeSessionId }, { bookingId: booking._id.toString() }],
      });

      if (!existingPayment) {
        const paymentDoc = {
          bookingId: booking._id.toString(),
          serviceTitle: booking.serviceTitle || "Repair Service",
          customerName: booking.customerName || "Customer",
          customerEmail: booking.customerEmail || session.customer_email || "",
          technicianName: booking.technicianName || "Technician",
          technicianEmail: booking.technicianEmail || "",
          amount: (session.amount_total || 0) / 100 || Number(booking.finalAmount || booking.basePrice || 0),
          currency: (session.currency || "usd").toLowerCase(),
          transactionId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : "TXN-" + randomBytes(4).toString("hex").toUpperCase(),
          stripeSessionId,
          paymentStatus: "paid",
          paidAt: new Date(),
        };

        await paymentsCol.insertOne(paymentDoc);
      }

      await bookingsCol.updateOne(
        { _id: booking._id },
        { $set: { paymentStatus: "paid", updatedAt: new Date() } }
      );

      console.log(`Payment confirmed for booking ${bookingId}`);
      return res.json({ received: true, success: true });
    } catch (err) {
      console.error("Webhook processing error:", err);
      return res.status(500).json({ error: "Webhook internal error." });
    }
  }
);

// General JSON middleware
app.use(express.json());

// Root test
app.get("/", (req, res) => {
  res.send("Mendizo API server is running fine!");
});

// POST /api/contact - Public contact form endpoint
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Your name is required." });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Your email address is required." });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    if (!subject || !subject.trim()) {
      return res.status(400).json({ error: "A subject is required." });
    }
    if (!message || message.trim().length < 10) {
      return res.status(400).json({ error: "Message must be at least 10 characters long." });
    }

    console.log(`[Contact Form Received] From: ${name.trim()} <${email.trim()}> | Subject: ${subject.trim()}`);
    return res.json({
      success: true,
      message: "Thank you for reaching out! Our support team will respond within 24 hours.",
    });
  } catch (error) {
    console.error("POST /api/contact error:", error);
    return res.status(500).json({ error: "Unable to process your contact request right now." });
  }
});

// ───────────────────────────────────────────────────────────────────────────

async function startServer() {
  try {
    await connectToMongoDB();
    app.listen(PORT, () => {
      console.log(`Mendizo server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
