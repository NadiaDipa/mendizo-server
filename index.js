
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Stripe setup ───────────────────────────────────────────────────────────
// STRIPE_SECRET_KEY must be set in .env (get from Stripe Dashboard → test mode)
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// ─── MongoDB setup ───────────────────────────────────────────────────────────
if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is missing in .env file");
}

const client = new MongoClient(process.env.MONGODB_URI);

// Module-level collection references, populated after connection
let usersCol, servicesCol, bookingsCol, paymentsCol, sessionsCol;

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("Successfully connected to MongoDB!");

    const database = client.db("mendizo");

    // Assign collections to module-level variables so routes can use them
    usersCol    = database.collection("user");
    servicesCol = database.collection("services");
    bookingsCol = database.collection("bookings");
    paymentsCol = database.collection("payments");
    sessionsCol = database.collection("session");
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}

// ─── Helper: parse a cookie string ──────────────────────────────────────────
// Returns the value of a named cookie from the Cookie header string
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=");
    if (key.trim() === name) {
      return decodeURIComponent(rest.join("=").trim());
    }
  }
  return null;
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────
// Verifies that the request comes from a logged-in customer using Better Auth
// session stored in MongoDB. Sets req.userId on success.
async function requireCustomer(req, res, next) {
  try {
    // 1. Read session token from cookie
    const token = parseCookie(req.headers.cookie, "better-auth.session_token");
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    // 2. Look up session in MongoDB by token field
    const session = await sessionsCol.findOne({ token });
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    // 3. Check expiry
    if (new Date(session.expiresAt) <= new Date()) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 4. Find the user by the session's userId (stored as string id field)
    const user = await usersCol.findOne({ id: session.userId });
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    // 5. Only allow customers
    if (user.role !== "customer") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 6. Attach userId to request and continue
    req.userId = user.id;
    next();
  } catch (err) {
    console.error("requireCustomer error:", err);
    res.status(401).json({ error: "Unauthorized" });
  }
}

// ─── Webhook route MUST be before express.json() ────────────────────────────
// Raw body is required for Stripe signature verification
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    if (!stripe) {
      console.error("Stripe not configured");
      return res.status(500).json({ error: "Stripe not configured" });
    }

    // Verify signature
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the checkout.session.completed event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { bookingId, customerId } = session.metadata;
      const stripeSessionId = session.id;
      const amount = session.amount_total / 100; // convert from paisa to taka

      try {
        // Idempotency check: skip if payment already recorded
        const existing = await paymentsCol.findOne({ stripeSessionId });
        if (!existing) {
          // Generate a simple random transaction ID
          const transactionId =
            "TXN-" + Math.random().toString(36).substring(2, 10).toUpperCase();

          // Insert payment record
          await paymentsCol.insertOne({
            bookingId,
            customerId,
            stripeSessionId,
            amount,
            status: "paid",
            paidAt: new Date(),
            transactionId,
          });

          // Mark the booking as paid
          await bookingsCol.updateOne(
            { _id: new ObjectId(bookingId) },
            { $set: { paymentStatus: "paid" } }
          );

          console.log(`Payment recorded for booking ${bookingId}`);
        } else {
          console.log(`Payment already recorded for session ${stripeSessionId}`);
        }
      } catch (err) {
        console.error("Error processing webhook event:", err);
      }
    }

    res.json({ received: true });
  }
);

// ─── General Middleware ──────────────────────────────────────────────────────
app.use(express.json());

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);

// ─── Home Route ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Mendizo server is running fine!");
});

// ─── GET /api/customer/stats ─────────────────────────────────────────────────
// Returns booking counts for the logged-in customer
app.get("/api/customer/stats", requireCustomer, async (req, res) => {
  try {
    const allBookings = await bookingsCol
      .find({ customerId: req.userId })
      .toArray();

    const total     = allBookings.length;
    const pending   = allBookings.filter((b) => b.status === "requested").length;
    const completed = allBookings.filter((b) => b.status === "completed").length;

    res.json({ total, pending, completed });
  } catch (err) {
    console.error("GET /api/customer/stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/customer/bookings ───────────────────────────────────────────────
// Returns all bookings for the logged-in customer with service & technician info
app.get("/api/customer/bookings", requireCustomer, async (req, res) => {
  try {
    // Get all bookings for this customer, newest first
    const bookings = await bookingsCol
      .find({ customerId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();

    // Enrich each booking with service title and technician name
    const enriched = await Promise.all(
      bookings.map(async (booking) => {
        // Fetch service name
        let serviceTitle = "N/A";
        if (booking.serviceId) {
          // serviceId might be a string or ObjectId — try ObjectId first
          let service = null;
          try {
            service = await servicesCol.findOne({
              _id: new ObjectId(booking.serviceId),
            });
          } catch {
            service = await servicesCol.findOne({ _id: booking.serviceId });
          }
          if (service) serviceTitle = service.title || service.name || "N/A";
        }

        // Fetch technician name from user collection by string id field
        let technicianName = "N/A";
        if (booking.technicianId) {
          const technician = await usersCol.findOne({ id: booking.technicianId });
          if (technician) technicianName = technician.name || "N/A";
        }

        return {
          _id:           booking._id,
          serviceTitle,
          technicianName,
          preferredDate: booking.preferredDate,
          amount:        booking.amount,
          status:        booking.status,
          paymentStatus: booking.paymentStatus || "unpaid",
          createdAt:     booking.createdAt,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error("GET /api/customer/bookings error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/customer/bookings/:id/cancel ───────────────────────────────────
// Cancels a booking that is still in "requested" status
app.post(
  "/api/customer/bookings/:id/cancel",
  requireCustomer,
  async (req, res) => {
    try {
      const bookingId = req.params.id;

      // Find booking by MongoDB _id
      let booking;
      try {
        booking = await bookingsCol.findOne({ _id: new ObjectId(bookingId) });
      } catch {
        return res.status(404).json({ error: "Booking not found" });
      }

      if (!booking) return res.status(404).json({ error: "Booking not found" });

      // Ownership check
      if (booking.customerId !== req.userId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Status check: only "requested" bookings can be cancelled
      if (booking.status !== "requested") {
        return res
          .status(400)
          .json({ error: "Only requested bookings can be cancelled" });
      }

      // Update status to cancelled
      await bookingsCol.updateOne(
        { _id: new ObjectId(bookingId) },
        { $set: { status: "cancelled" } }
      );

      res.json({ success: true });
    } catch (err) {
      console.error("POST /api/customer/bookings/:id/cancel error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// ─── POST /api/customer/checkout ─────────────────────────────────────────────
// Creates a Stripe Checkout Session for a completed, unpaid booking
app.post("/api/customer/checkout", requireCustomer, async (req, res) => {
  try {
    // Check Stripe is configured
    if (!stripe) {
      return res.status(500).json({
        error:
          "Stripe is not configured. Add STRIPE_SECRET_KEY to your .env file.",
      });
    }

    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({ error: "bookingId is required" });
    }

    // Find the booking
    let booking;
    try {
      booking = await bookingsCol.findOne({ _id: new ObjectId(bookingId) });
    } catch {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Ownership check
    if (booking.customerId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Must be completed and unpaid
    if (booking.status !== "completed") {
      return res
        .status(400)
        .json({ error: "Booking must be completed before payment" });
    }

    if (booking.paymentStatus === "paid") {
      return res.status(400).json({ error: "Already paid" });
    }

    // Create Stripe Checkout Session
    // Amount from DB (in taka) → Stripe expects smallest unit (paisa), so × 100
    const stripeSession = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "bdt",
            product_data: {
              name: "Mendizo Service Booking",
            },
            unit_amount: Math.round(booking.amount * 100), // paisa
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url:
        "http://localhost:3000/dashboard/customer/bookings?payment=success",
      cancel_url:
        "http://localhost:3000/dashboard/customer/bookings?payment=cancelled",
      metadata: {
        bookingId: booking._id.toString(),
        customerId: req.userId,
      },
    });

    res.json({ url: stripeSession.url });
  } catch (err) {
    console.error("POST /api/customer/checkout error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/customer/payments ───────────────────────────────────────────────
// Returns all payments for the logged-in customer with totals
app.get("/api/customer/payments", requireCustomer, async (req, res) => {
  try {
    const payments = await paymentsCol
      .find({ customerId: req.userId })
      .sort({ paidAt: -1 })
      .toArray();

    // Enrich with service title and technician name via booking
    const enriched = await Promise.all(
      payments.map(async (payment) => {
        let serviceTitle   = "N/A";
        let technicianName = "N/A";

        if (payment.bookingId) {
          // bookingId stored in payments is a string from ObjectId.toString()
          let booking = null;
          try {
            booking = await bookingsCol.findOne({
              _id: new ObjectId(payment.bookingId),
            });
          } catch {
            // ignore invalid id
          }

          if (booking) {
            // Fetch service
            if (booking.serviceId) {
              let service = null;
              try {
                service = await servicesCol.findOne({
                  _id: new ObjectId(booking.serviceId),
                });
              } catch {
                service = await servicesCol.findOne({ _id: booking.serviceId });
              }
              if (service) serviceTitle = service.title || service.name || "N/A";
            }

            // Fetch technician
            if (booking.technicianId) {
              const technician = await usersCol.findOne({
                id: booking.technicianId,
              });
              if (technician) technicianName = technician.name || "N/A";
            }
          }
        }

        return {
          _id:           payment._id,
          serviceTitle,
          technicianName,
          amount:        payment.amount,
          transactionId: payment.transactionId,
          paidAt:        payment.paidAt,
          status:        payment.status,
        };
      })
    );

    // Sum of all paid amounts
    const totalPaid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

    res.json({ payments: enriched, totalPaid });
  } catch (err) {
    console.error("GET /api/customer/payments error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
async function startServer() {
  try {
    await connectToMongoDB();

    app.listen(PORT, () => {
      console.log(`Mendizo app listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
