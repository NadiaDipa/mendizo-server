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
let contactMessagesCol;

async function connectToMongoDB() {
  await client.connect();
  console.log("Successfully connected to MongoDB!");

  const database = client.db("mendizo");

  usersCol = database.collection("user");
  servicesCol = database.collection("services");
  bookingsCol = database.collection("bookings");
  paymentsCol = database.collection("payments");
  contactMessagesCol = database.collection("contactMessages");

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

// POST /api/contact - Public contact form endpoint (saves to contactMessages collection)
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Your name is required." });
    }
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "Your email address is required." });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    if (!subject || typeof subject !== "string" || !subject.trim()) {
      return res.status(400).json({ error: "A subject is required." });
    }
    if (!message || typeof message !== "string" || message.trim().length < 10) {
      return res.status(400).json({ error: "Message must be at least 10 characters long." });
    }

    const contactDoc = {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      subject: subject.trim(),
      message: message.trim(),
      createdAt: new Date(),
    };

    const result = await contactMessagesCol.insertOne(contactDoc);

    console.log(`[Contact Form Saved] ID: ${result.insertedId} | From: ${contactDoc.name} <${contactDoc.email}> | Subject: ${contactDoc.subject}`);

    return res.status(201).json({
      success: true,
      message: "Thank you for reaching out! Your message has been received.",
      id: result.insertedId,
    });
  } catch (error) {
    console.error("POST /api/contact error:", error);
    return res.status(500).json({ error: "Unable to process your contact request right now." });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PUBLIC SERVICE APIS (CHALLENGE 1: Server-Side Search, Filter & Sort)
// ───────────────────────────────────────────────────────────────────────────

// GET /api/services - Public with Server-Side Search, Filter & Sort
app.get("/api/services", async (req, res) => {
  try {
    const { search, category, serviceMode, sort, limit, page } = req.query;

    // By default only available services are public (homepage behaviour).
    // The All Services page opts in to include unavailable approved services so
    // customers can see their availability badge before opening the details.
    const includeUnavailable = req.query.includeUnavailable === "true";

    const query = {
      approvalStatus: "approved",
      ...(includeUnavailable ? {} : { isAvailable: true }),
    };

    // Server-side search by title or category
    if (search && typeof search === "string" && search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      query.$or = [
        { title: { $regex: searchRegex } },
        { category: { $regex: searchRegex } },
        { description: { $regex: searchRegex } },
      ];
    }

    // Category filter
    if (category && typeof category === "string" && category.trim() && category !== "all") {
      const catTrim = category.trim();
      // Handle slug formats or exact category names
      const catMap = {
        "smartphone": "Smartphone",
        "laptop-service": "Laptop & PC",
        "laptop-pc": "Laptop & PC",
        "ac-servicing": "AC",
        "ac": "AC",
        "refrigerator": "Refrigerator",
        "washing-machine": "Washing Machine",
        "tv-repair": "TV",
        "tv": "TV",
        "electrical-wiring": "Electrical",
        "electrical": "Electrical",
      };
      const normalizedCat = catMap[catTrim.toLowerCase()] || catTrim;
      query.category = { $regex: new RegExp(`^${normalizedCat}$`, "i") };
    }

    // Service mode filter
    if (serviceMode && typeof serviceMode === "string" && serviceMode.trim() && serviceMode !== "all") {
      const modeTrim = serviceMode.trim();
      if (modeTrim.toLowerCase().includes("home")) {
        query.serviceMode = { $regex: /home/i };
      } else if (modeTrim.toLowerCase().includes("shop") || modeTrim.toLowerCase().includes("drop")) {
        query.serviceMode = { $regex: /shop/i };
      } else {
        query.serviceMode = modeTrim;
      }
    }

    // Server-side sort
    let sortOption = { createdAt: -1 }; // Default newest
    if (sort === "price-asc") {
      sortOption = { basePrice: 1 };
    } else if (sort === "price-desc") {
      sortOption = { basePrice: -1 };
    } else if (sort === "newest") {
      sortOption = { createdAt: -1 };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 100);
    const skipNum = (pageNum - 1) * limitNum;

    const total = await servicesCol.countDocuments(query);
    const services = await servicesCol
      .find(query)
      .sort(sortOption)
      .skip(skipNum)
      .limit(limitNum)
      .toArray();

    // Map image/imageUrl consistently
    const formatted = services.map((s) => ({
      ...s,
      image: s.image || s.imageUrl || "",
      imageUrl: s.image || s.imageUrl || "",
    }));

    res.json({
      success: true,
      services: formatted,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    console.error("GET /api/services error:", error);
    res.status(500).json({ error: "Unable to fetch services." });
  }
});

// GET /api/services/:id - Public Service Details + Technician Profile Summary
app.get("/api/services/:id", async (req, res) => {
  try {
    const serviceId = req.params.id;
    const service = await findByIdOrString(servicesCol, serviceId);

    if (!service) {
      return res.status(404).json({ error: "Service not found." });
    }

    // Lookup technician profile for technician summary (name, photo, area, bio)
    let technicianSummary = {
      name: service.technicianName || "Verified Technician",
      email: service.technicianEmail || "",
      image: "",
      area: service.serviceArea || "Dhaka, Bangladesh",
      bio: "Professional and certified repair specialist with years of hands-on experience.",
    };

    if (service.technicianEmail) {
      const techUser = await usersCol.findOne({ email: service.technicianEmail });
      if (techUser) {
        technicianSummary = {
          name: techUser.name || technicianSummary.name,
          email: techUser.email || technicianSummary.email,
          image: techUser.image || "",
          area: techUser.area || technicianSummary.area,
          bio: techUser.bio || technicianSummary.bio,
        };
      }
    }

    res.json({
      success: true,
      service: {
        ...service,
        image: service.image || service.imageUrl || "",
        imageUrl: service.image || service.imageUrl || "",
      },
      technician: technicianSummary,
    });
  } catch (error) {
    console.error("GET /api/services/:id error:", error);
    res.status(500).json({ error: "Unable to fetch service details." });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// CUSTOMER BOOKINGS & PAYMENTS (CHALLENGE 2 & CHALLENGE 3)
// ───────────────────────────────────────────────────────────────────────────

// POST /api/bookings - Customer submits repair request
app.post("/api/bookings", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const {
      serviceId,
      customerPhone,
      phone,
      address,
      preferredDate,
      problemDescription,
      description,
    } = req.body;

    const contactPhone = String(customerPhone || phone || "").trim();
    const serviceAddress = String(address || "").trim();
    const problem = String(problemDescription || description || "").trim();

    if (!serviceId) {
      return res.status(400).json({ error: "Service ID is required." });
    }

    if (!contactPhone) {
      return res.status(400).json({ error: "Contact phone number is required." });
    }

    if (!serviceAddress) {
      return res.status(400).json({ error: "Service/pickup address is required." });
    }

    if (!preferredDate) {
      return res.status(400).json({ error: "Preferred service date is required." });
    }

    const prefDate = new Date(preferredDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (isNaN(prefDate.getTime()) || prefDate < today) {
      return res.status(400).json({
        error: "Preferred date must be today or a future date.",
      });
    }

    if (problem.length < 20) {
      return res.status(400).json({
        error: "Problem description must be at least 20 characters.",
      });
    }

    // Verify service exists
    const service = await findByIdOrString(servicesCol, serviceId);
    if (!service) {
      return res.status(404).json({ error: "Service not found." });
    }

    if (service.approvalStatus !== "approved" || service.isAvailable === false) {
      return res.status(400).json({
        error: "This service is currently not available for booking.",
      });
    }

    // Technician cannot request their own service
    if (service.technicianEmail === req.user.email) {
      return res.status(400).json({
        error: "You cannot request your own service.",
      });
    }

    // Business Rule: Prevent duplicate active requests for the same service
    const existingActiveBooking = await bookingsCol.findOne({
      serviceId: service._id.toString(),
      customerEmail: req.user.email,
      status: { $in: ["requested", "accepted", "in-progress"] },
    });

    if (existingActiveBooking) {
      return res.status(400).json({
        error: "You already have an active request for this service.",
      });
    }

    // Create booking document copying required fields from service
    const basePrice = Number(service.basePrice || service.price || 0);

    const bookingDoc = {
      serviceId: service._id.toString(),
      serviceTitle: service.title,
      serviceImage: service.image || service.imageUrl || "",
      category: service.category,
      basePrice,
      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,
      technicianId: service.technicianId || "",

      customerId: req.userId,
      customerName: req.user.name || "Customer",
      customerEmail: req.user.email,
      customerPhone: contactPhone,
      address: serviceAddress,
      preferredDate: prefDate,
      problemDescription: problem,

      status: "requested",
      finalAmount: basePrice,
      amount: basePrice,
      paymentStatus: "unpaid",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookingsCol.insertOne(bookingDoc);

    res.status(201).json({
      success: true,
      message: "Repair request submitted successfully!",
      bookingId: result.insertedId,
      booking: { ...bookingDoc, _id: result.insertedId },
    });
  } catch (error) {
    console.error("POST /api/bookings error:", error);
    res.status(500).json({ error: "Unable to submit booking request." });
  }
});

// PATCH /api/bookings/:id/cancel - Customer cancels a requested booking
app.patch(
  ["/api/bookings/:id/cancel", "/api/customer/bookings/:id/cancel"],
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const bookingId = req.params.id;
      const booking = await findByIdOrString(bookingsCol, bookingId);

      if (!booking) {
        return res.status(404).json({ error: "Booking not found." });
      }

      // Check ownership
      const isOwner =
        booking.customerEmail === req.user.email ||
        booking.customerId === req.userId;

      if (!isOwner) {
        return res.status(403).json({ error: "Forbidden. You do not own this booking." });
      }

      // Customer can cancel only while status === 'requested'
      if (booking.status !== "requested") {
        return res.status(400).json({
          error: "Only requested bookings can be cancelled.",
        });
      }

      await bookingsCol.updateOne(
        { _id: booking._id },
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
        }
      );

      res.json({
        success: true,
        message: "Booking cancelled successfully.",
      });
    } catch (error) {
      console.error("PATCH cancel booking error:", error);
      res.status(500).json({ error: "Unable to cancel booking." });
    }
  }
);

// GET /api/bookings/my & /api/customer/bookings - Customer views their bookings
app.get(
  ["/api/bookings/my", "/api/customer/bookings"],
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const bookings = await bookingsCol
        .find({
          $or: [
            { customerEmail: req.user.email },
            { customerId: req.userId },
          ],
        })
        .sort({ createdAt: -1 })
        .toArray();

      res.json(bookings);
    } catch (error) {
      console.error("GET customer bookings error:", error);
      res.status(500).json({ error: "Unable to fetch bookings." });
    }
  }
);

// GET /api/customer/stats - Customer dashboard stats
app.get("/api/customer/stats", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const filter = {
      $or: [
        { customerEmail: req.user.email },
        { customerId: req.userId },
      ],
    };

    const [total, pending, completed] = await Promise.all([
      bookingsCol.countDocuments(filter),
      bookingsCol.countDocuments({
        ...filter,
        status: { $in: ["requested", "accepted", "in-progress"] },
      }),
      bookingsCol.countDocuments({
        ...filter,
        status: "completed",
      }),
    ]);

    res.json({ total, pending, completed });
  } catch (error) {
    console.error("GET /api/customer/stats error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/payments/create-checkout-session - Create Stripe Checkout Session
app.post(
  ["/api/payments/create-checkout-session", "/api/customer/checkout"],
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const { bookingId } = req.body;

      if (!bookingId) {
        return res.status(400).json({ error: "Booking ID is required." });
      }

      const booking = await findByIdOrString(bookingsCol, bookingId);
      if (!booking) {
        return res.status(404).json({ error: "Booking not found." });
      }

      // Verify customer owns this booking
      const isOwner =
        booking.customerEmail === req.user.email ||
        booking.customerId === req.userId;

      if (!isOwner) {
        return res.status(403).json({ error: "Forbidden. You do not own this booking." });
      }

      // Enforce Payment Gate: Only completed and unpaid bookings can be paid
      if (booking.status !== "completed") {
        return res.status(400).json({
          error: "Payment is only available after the technician completes the service.",
        });
      }

      if (booking.paymentStatus === "paid") {
        return res.status(400).json({
          error: "This booking is already paid.",
        });
      }

      // Load amount from DB (Never trust client sent amount!)
      const amount = Number(booking.finalAmount || booking.amount || booking.basePrice);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid booking amount." });
      }

      const unitAmountInCents = Math.round(amount * 100);

      // If Stripe secret key is configured, create live Stripe Checkout Session
      if (!stripe) {
        return res.status(503).json({
          error:
            "Stripe is not configured on this server. Set STRIPE_SECRET_KEY in the server .env file to enable payments.",
        });
      }

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `Mendizo Repair: ${booking.serviceTitle}`,
                description: `Technician: ${booking.technicianName} | Booking ID: ${booking._id}`,
              },
              unit_amount: unitAmountInCents,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: req.user.email,
        success_url: `${CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${CLIENT_URL}/payment/cancel`,
        metadata: {
          bookingId: booking._id.toString(),
          customerEmail: req.user.email,
        },
      });

      return res.json({ url: session.url, sessionId: session.id });
    } catch (error) {
      console.error("POST create-checkout-session error:", error);
      res.status(500).json({ error: "Unable to create payment session." });
    }
  }
);

// GET /api/payments/verify - Verify Stripe session and record payment
app.get("/api/payments/verify", verifyToken, async (req, res) => {
  try {
    const { session_id } = req.query;

    if (!session_id) {
      return res.status(400).json({ error: "session_id is required." });
    }

    if (!stripe) {
      return res.status(503).json({
        error:
          "Stripe is not configured on this server. Set STRIPE_SECRET_KEY in the server .env file to enable payments.",
      });
    }

    let bookingId = "";
    let customerEmail = req.user.email;
    let paidAmount = 0;
    let transactionId = "TXN-" + randomBytes(4).toString("hex").toUpperCase();
    let isPaid = false;

    {
      const session = await stripe.checkout.sessions.retrieve(String(session_id));
      if (session && session.payment_status === "paid") {
        isPaid = true;
        bookingId = session.metadata?.bookingId;
        customerEmail = session.metadata?.customerEmail || session.customer_email || req.user.email;
        paidAmount = (session.amount_total || 0) / 100;
        transactionId = typeof session.payment_intent === "string" ? session.payment_intent : transactionId;
      }
    }

    if (!isPaid || !bookingId) {
      return res.status(400).json({ error: "Payment verification failed or unpaid." });
    }

    const booking = await findByIdOrString(bookingsCol, bookingId);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }

    if (paidAmount === 0) {
      paidAmount = Number(booking.finalAmount || booking.amount || booking.basePrice);
    }

    // Check if payment already recorded (idempotent / prevent double insert)
    let payment = await paymentsCol.findOne({
      $or: [
        { stripeSessionId: String(session_id) },
        { bookingId: booking._id.toString() },
      ],
    });

    if (!payment) {
      const paymentDoc = {
        bookingId: booking._id.toString(),
        serviceTitle: booking.serviceTitle,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        technicianName: booking.technicianName,
        technicianEmail: booking.technicianEmail,
        amount: paidAmount,
        currency: "usd",
        transactionId,
        stripeSessionId: String(session_id),
        paymentStatus: "paid",
        paidAt: new Date(),
      };

      const result = await paymentsCol.insertOne(paymentDoc);
      payment = { ...paymentDoc, _id: result.insertedId };
    }

    // Update booking paymentStatus
    await bookingsCol.updateOne(
      { _id: booking._id },
      { $set: { paymentStatus: "paid", updatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: "Payment successfully verified and recorded.",
      payment,
      booking: { ...booking, paymentStatus: "paid" },
    });
  } catch (error) {
    console.error("GET /api/payments/verify error:", error);
    res.status(500).json({ error: "Payment verification error." });
  }
});

// GET /api/customer/payments - Customer payment history
app.get("/api/customer/payments", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const payments = await paymentsCol
      .find({
        $or: [
          { customerEmail: req.user.email },
          { customerId: req.userId },
        ],
      })
      .sort({ paidAt: -1 })
      .toArray();

    const totalPaid = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    res.json({
      payments,
      totalPaid,
    });
  } catch (error) {
    console.error("GET customer payments error:", error);
    res.status(500).json({ error: "Unable to fetch payment history." });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// TECHNICIAN SERVICE MANAGEMENT (FULL CRUD & CHALLENGE 2, 3)
// ───────────────────────────────────────────────────────────────────────────

// POST /api/services & /api/technician/services - Technician adds a service
app.post(
  ["/api/services", "/api/technician/services"],
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const {
        title,
        category,
        description,
        basePrice,
        price,
        estimatedDuration,
        serviceMode,
        serviceArea,
        image,
        imageUrl,
      } = req.body;

      const servicePrice = Number(basePrice ?? price);
      const serviceImg = String(image || imageUrl || "").trim();

      if (
        !title?.trim() ||
        !category?.trim() ||
        !description?.trim() ||
        !Number.isFinite(servicePrice) ||
        servicePrice <= 0 ||
        !serviceMode?.trim() ||
        !serviceArea?.trim() ||
        !serviceImg
      ) {
        return res.status(400).json({
          error: "Please provide all required service information.",
        });
      }

      const serviceDoc = {
        title: title.trim(),
        category: category.trim(),
        description: description.trim(),
        basePrice: servicePrice,
        estimatedDuration: String(estimatedDuration || "").trim(),
        serviceMode: serviceMode.trim(),
        serviceArea: serviceArea.trim(),
        image: serviceImg,
        imageUrl: serviceImg,

        technicianId: req.userId,
        technicianName: req.user.name || "Technician",
        technicianEmail: req.user.email,

        approvalStatus: "pending", // Waiting for admin approval
        isAvailable: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await servicesCol.insertOne(serviceDoc);

      res.status(201).json({
        success: true,
        message: "Service submitted and waiting for admin approval.",
        serviceId: result.insertedId,
        service: { ...serviceDoc, _id: result.insertedId },
      });
    } catch (error) {
      console.error("POST create service error:", error);
      res.status(500).json({ error: "Unable to create service." });
    }
  }
);

// GET /api/services/technician/my & /api/technician/services - Technician's own services
app.get(
  ["/api/services/technician/my", "/api/technician/services"],
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const services = await servicesCol
        .find({
          $or: [
            { technicianEmail: req.user.email },
            { technicianId: req.userId },
          ],
        })
        .sort({ createdAt: -1 })
        .toArray();

      const formatted = services.map((s) => ({
        ...s,
        image: s.image || s.imageUrl || "",
        imageUrl: s.image || s.imageUrl || "",
      }));

      res.json(formatted);
    } catch (error) {
      console.error("GET technician services error:", error);
      res.status(500).json({ error: "Unable to fetch services." });
    }
  }
);

// PATCH /api/services/:id & /api/technician/services/:id - Update technician's service
app.patch(
  ["/api/services/:id", "/api/technician/services/:id"],
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const serviceId = req.params.id;
      const service = await findByIdOrString(servicesCol, serviceId);

      if (!service) {
        return res.status(404).json({ error: "Service not found." });
      }

      // Verify ownership
      const isOwner =
        service.technicianEmail === req.user.email ||
        service.technicianId === req.userId;

      if (!isOwner) {
        return res.status(403).json({ error: "Forbidden. You do not own this service." });
      }

      const {
        title,
        category,
        description,
        basePrice,
        estimatedDuration,
        serviceMode,
        serviceArea,
        image,
        imageUrl,
      } = req.body;

      const updateData = {
        updatedAt: new Date(),
        approvalStatus: "pending", // Requirement: Editing sets approvalStatus back to 'pending'!
      };

      if (title?.trim()) updateData.title = title.trim();
      if (category?.trim()) updateData.category = category.trim();
      if (description?.trim()) updateData.description = description.trim();
      if (basePrice !== undefined) {
        const p = Number(basePrice);
        if (Number.isFinite(p) && p > 0) updateData.basePrice = p;
      }
      if (estimatedDuration !== undefined) updateData.estimatedDuration = String(estimatedDuration).trim();
      if (serviceMode?.trim()) updateData.serviceMode = serviceMode.trim();
      if (serviceArea?.trim()) updateData.serviceArea = serviceArea.trim();
      const img = image || imageUrl;
      if (img?.trim()) {
        updateData.image = img.trim();
        updateData.imageUrl = img.trim();
      }

      await servicesCol.updateOne({ _id: service._id }, { $set: updateData });

      res.json({
        success: true,
        message: "Service updated. It is waiting for admin approval.",
      });
    } catch (error) {
      console.error("PATCH service error:", error);
      res.status(500).json({ error: "Unable to update service." });
    }
  }
);

// DELETE /api/services/:id & /api/technician/services/:id - Delete technician's service
app.delete(
  ["/api/services/:id", "/api/technician/services/:id"],
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const serviceId = req.params.id;
      const service = await findByIdOrString(servicesCol, serviceId);

      if (!service) {
        return res.status(404).json({ error: "Service not found." });
      }

      const isOwner =
        service.technicianEmail === req.user.email ||
        service.technicianId === req.userId;

      if (!isOwner) {
        return res.status(403).json({ error: "Forbidden. You do not own this service." });
      }

      await servicesCol.deleteOne({ _id: service._id });

      res.json({
        success: true,
        message: "Service deleted successfully.",
      });
    } catch (error) {
      console.error("DELETE service error:", error);
      res.status(500).json({ error: "Unable to delete service." });
    }
  }
);

// PATCH /api/services/:id/availability & /api/technician/services/:id/availability - Toggle service availability
app.patch(
  ["/api/services/:id/availability", "/api/technician/services/:id/availability"],
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const serviceId = req.params.id;
      const { isAvailable } = req.body;

      const service = await findByIdOrString(servicesCol, serviceId);
      if (!service) {
        return res.status(404).json({ error: "Service not found." });
      }

      const isOwner =
        service.technicianEmail === req.user.email ||
        service.technicianId === req.userId;

      if (!isOwner) {
        return res.status(403).json({ error: "Forbidden. You do not own this service." });
      }

      const newStatus = typeof isAvailable === "boolean" ? isAvailable : !service.isAvailable;

      await servicesCol.updateOne(
        { _id: service._id },
        { $set: { isAvailable: newStatus, updatedAt: new Date() } }
      );

      res.json({
        success: true,
        isAvailable: newStatus,
        message: newStatus ? "Service is now available." : "Service is now unavailable.",
      });
    } catch (error) {
      console.error("PATCH availability error:", error);
      res.status(500).json({ error: "Unable to update availability." });
    }
  }
);

// GET /api/bookings/technician & /api/technician/requests - Technician requests
app.get(
  ["/api/bookings/technician", "/api/technician/requests"],
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const bookings = await bookingsCol
        .find({
          $or: [
            { technicianEmail: req.user.email },
            { technicianId: req.userId },
          ],
        })
        .sort({ createdAt: -1 })
        .toArray();

      res.json(bookings);
    } catch (error) {
      console.error("GET technician requests error:", error);
      res.status(500).json({ error: "Unable to fetch technician requests." });
    }
  }
);

// PATCH /api/bookings/:id/status & /api/technician/requests/:id/status - Update job status pipeline (Challenge 3)
app.patch(
  ["/api/bookings/:id/status", "/api/technician/requests/:id/status"],
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const bookingId = req.params.id;
      const { status, finalAmount } = req.body;

      const booking = await findByIdOrString(bookingsCol, bookingId);
      if (!booking) {
        return res.status(404).json({ error: "Booking not found." });
      }

      // Verify technician ownership
      const isOwner =
        booking.technicianEmail === req.user.email ||
        booking.technicianId === req.userId;

      if (!isOwner) {
        return res.status(403).json({ error: "Forbidden. You do not own this job." });
      }

      // Strictly Enforced Status Pipeline (Challenge 3)
      // requested -> accepted or rejected
      // accepted -> in-progress
      // in-progress -> completed (requires finalAmount)
      const validTransitions = {
        requested: ["accepted", "rejected"],
        accepted: ["in-progress"],
        "in-progress": ["completed"],
      };

      if (!validTransitions[booking.status]?.includes(status)) {
        return res.status(400).json({
          error: `Cannot transition status from '${booking.status}' to '${status}'.`,
        });
      }

      const updateFields = {
        status,
        updatedAt: new Date(),
      };

      if (status === "completed") {
        const amount = Number(finalAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
          return res.status(400).json({
            error: "Must send finalAmount (positive number) when completing a job.",
          });
        }
        updateFields.finalAmount = amount;
        updateFields.amount = amount;
        updateFields.completedAt = new Date();
      }

      await bookingsCol.updateOne({ _id: booking._id }, { $set: updateFields });

      res.json({
        success: true,
        message: `Booking status updated to ${status}.`,
        status,
        finalAmount: updateFields.finalAmount,
      });
    } catch (error) {
      console.error("PATCH booking status error:", error);
      res.status(500).json({ error: "Unable to update booking status." });
    }
  }
);

// ───────────────────────────────────────────────────────────────────────────
// ADMIN MANAGEMENT (CHALLENGE 2)
// ───────────────────────────────────────────────────────────────────────────

// GET /api/admin/stats - Admin Dashboard Overview Stats
app.get("/api/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [totalUsers, totalTechnicians, pendingServices, totalBookings, payments] =
      await Promise.all([
        usersCol.countDocuments(),
        usersCol.countDocuments({ role: "technician" }),
        servicesCol.countDocuments({ approvalStatus: "pending" }),
        bookingsCol.countDocuments(),
        paymentsCol.find({ paymentStatus: "paid" }).toArray(),
      ]);

    const totalRevenue = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    res.json({
      totalUsers,
      totalTechnicians,
      pendingServices,
      totalBookings,
      totalRevenue,
    });
  } catch (error) {
    console.error("GET /api/admin/stats error:", error);
    res.status(500).json({ error: "Unable to fetch admin stats." });
  }
});

// GET /api/admin/users - List all users
app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await usersCol
      .find({})
      .project({
        _id: 1,
        id: 1,
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        phone: 1,
        area: 1,
        createdAt: 1,
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(users);
  } catch (error) {
    console.error("GET /api/admin/users error:", error);
    res.status(500).json({ error: "Unable to fetch users." });
  }
});

// PATCH /api/admin/users/:id/role - Admin changes user role
app.patch("/api/admin/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { role } = req.body;

    if (!["customer", "technician", "admin"].includes(role)) {
      return res.status(400).json({
        error: "Invalid role. Must be 'customer', 'technician', or 'admin'.",
      });
    }

    const targetUser = await findByIdOrString(usersCol, userId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found." });
    }

    // Rule: Admin cannot change their own role!
    if (targetUser.email === req.user.email) {
      return res.status(400).json({
        error: "Admins cannot change their own role.",
      });
    }

    await usersCol.updateOne(
      { _id: targetUser._id },
      { $set: { role, updatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: `User role updated to ${role}.`,
    });
  } catch (error) {
    console.error("PATCH /api/admin/users/:id/role error:", error);
    res.status(500).json({ error: "Unable to update user role." });
  }
});

// GET /api/admin/services - List all services from all technicians with approval filter
app.get("/api/admin/services", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { approvalStatus } = req.query;
    const query = {};

    if (approvalStatus && approvalStatus !== "all") {
      query.approvalStatus = approvalStatus;
    }

    const services = await servicesCol
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    const formatted = services.map((s) => ({
      ...s,
      image: s.image || s.imageUrl || "",
      imageUrl: s.image || s.imageUrl || "",
    }));

    res.json(formatted);
  } catch (error) {
    console.error("GET /api/admin/services error:", error);
    res.status(500).json({ error: "Unable to fetch services." });
  }
});

// PATCH /api/admin/services/:id/approval - Approve or Reject service
app.patch("/api/admin/services/:id/approval", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const serviceId = req.params.id;
    const { approvalStatus } = req.body;

    if (!["approved", "rejected", "pending"].includes(approvalStatus)) {
      return res.status(400).json({
        error: "approvalStatus must be 'approved', 'rejected', or 'pending'.",
      });
    }

    const service = await findByIdOrString(servicesCol, serviceId);
    if (!service) {
      return res.status(404).json({ error: "Service not found." });
    }

    await servicesCol.updateOne(
      { _id: service._id },
      { $set: { approvalStatus, updatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: `Service status set to ${approvalStatus}.`,
      approvalStatus,
    });
  } catch (error) {
    console.error("PATCH service approval error:", error);
    res.status(500).json({ error: "Unable to update approval status." });
  }
});

// GET /api/admin/bookings - Read-only table of all bookings
app.get("/api/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};
    if (status && status !== "all") {
      query.status = status;
    }

    const bookings = await bookingsCol
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(bookings);
  } catch (error) {
    console.error("GET /api/admin/bookings error:", error);
    res.status(500).json({ error: "Unable to fetch bookings." });
  }
});

// GET /api/admin/payments & /api/admin/transactions - All transactions & total revenue
app.get(
  ["/api/admin/payments", "/api/admin/transactions"],
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const payments = await paymentsCol
        .find({})
        .sort({ paidAt: -1 })
        .toArray();

      const totalRevenue = payments
        .filter((p) => p.paymentStatus === "paid")
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

      res.json({
        payments,
        totalRevenue,
      });
    } catch (error) {
      console.error("GET /api/admin/payments error:", error);
      res.status(500).json({ error: "Unable to fetch transactions." });
    }
  }
);

// ───────────────────────────────────────────────────────────────────────────
// USER PROFILE APIS (SHARED)
// ───────────────────────────────────────────────────────────────────────────

// GET /api/users/profile - Get profile data
app.get("/api/users/profile", verifyToken, async (req, res) => {
  try {
    const user = await usersCol.findOne({ email: req.user.email });
    if (!user) {
      return res.status(404).json({ error: "User profile not found." });
    }

    res.json({
      name: user.name || "",
      email: user.email || "",
      role: user.role || "customer",
      image: user.image || "",
      phone: user.phone || "",
      area: user.area || "",
      bio: user.bio || "",
    });
  } catch (error) {
    console.error("GET profile error:", error);
    res.status(500).json({ error: "Unable to fetch profile." });
  }
});

// PATCH /api/users/profile - Update profile data
app.patch("/api/users/profile", verifyToken, async (req, res) => {
  try {
    const { name, phone, area, bio, image } = req.body;

    const updateFields = {
      updatedAt: new Date(),
    };

    if (typeof name === "string" && name.trim()) updateFields.name = name.trim();
    if (typeof phone === "string") updateFields.phone = phone.trim();
    if (typeof area === "string") updateFields.area = area.trim();
    if (typeof bio === "string") updateFields.bio = bio.trim();
    if (typeof image === "string") updateFields.image = image.trim();

    await usersCol.updateOne(
      { email: req.user.email },
      { $set: updateFields }
    );

    const updatedUser = await usersCol.findOne({ email: req.user.email });

    res.json({
      success: true,
      message: "Profile updated successfully.",
      user: {
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        image: updatedUser.image,
        phone: updatedUser.phone,
        area: updatedUser.area,
        bio: updatedUser.bio,
      },
    });
  } catch (error) {
    console.error("PATCH /api/users/profile error:", error);
    res.status(500).json({ error: "Unable to update profile." });
  }
});

// Start Server
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
