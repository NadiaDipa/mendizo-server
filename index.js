
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
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

// ─── Stripe setup ───────────────────────────────────────────────────────────

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// ─── MongoDB setup ──────────────────────────────────────────────────────────

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

  await paymentsCol.createIndex(
    { stripeSessionId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        stripeSessionId: { $type: "string" },
      },
    }
  );

  console.log("MongoDB indexes are ready!");
}

// ─── Helper: validate MongoDB ObjectId ──────────────────────────────────────

function isValidObjectId(id) {
  return typeof id === "string" && /^[a-fA-F0-9]{24}$/.test(id);
}

// ─── Helper: find document by ObjectId or string ID ─────────────────────────

async function findByIdOrString(collection, id) {
  if (!id) return null;

  if (id instanceof ObjectId) {
    return collection.findOne({ _id: id });
  }

  if (typeof id === "string" && isValidObjectId(id)) {
    const document = await collection.findOne({
      _id: new ObjectId(id),
    });

    if (document) return document;
  }

  return collection.findOne({ _id: id });
}

// ─── Customer Authentication Middleware ─────────────────────────────────────

async function requireCustomer(req, res, next) {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session?.user) {
      return res.status(401).json({
        error: "Unauthorized. Please log in.",
      });
    }

    if (session.user.role !== "customer") {
      return res.status(403).json({
        error: "Access denied. Customer account required.",
      });
    }

    req.userId = session.user.id;

    return next();
  } catch (error) {
    console.error("Customer authentication error:", error);

    return res.status(500).json({
      error: "Unable to verify authentication.",
    });
  }
}

// ─── Technician Authentication Middleware ───────────────────────────────────

async function requireTechnician(req, res, next) {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session?.user) {
      return res.status(401).json({
        error: "Unauthorized. Please log in.",
      });
    }

    if (session.user.role !== "technician") {
      return res.status(403).json({
        error: "Access denied. Technician account required.",
      });
    }

    req.userId = session.user.id;

    return next();
  } catch (error) {
    console.error("Technician authentication error:", error);

    return res.status(500).json({
      error: "Unable to verify authentication.",
    });
  }
}

// ─── CORS Middleware ────────────────────────────────────────────────────────

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);

// ─── Stripe Webhook ─────────────────────────────────────────────────────────
// IMPORTANT: This route must be before express.json().

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not configured.",
      });
    }

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(500).json({
        error: "STRIPE_WEBHOOK_SECRET is missing.",
      });
    }

    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Webhook signature verification failed:", error.message);

      return res.status(400).send("Invalid Stripe webhook signature.");
    }

    if (event.type !== "checkout.session.completed") {
      return res.json({ received: true });
    }

    const checkoutSession = event.data.object;

    if (checkoutSession.payment_status !== "paid") {
      return res.json({ received: true });
    }

    try {
      const bookingId = checkoutSession.metadata?.bookingId;
      const customerId = checkoutSession.metadata?.customerId;
      const stripeSessionId = checkoutSession.id;

      if (!isValidObjectId(bookingId) || !customerId) {
        return res.status(400).json({
          error: "Invalid booking or customer metadata.",
        });
      }

      const bookingObjectId = new ObjectId(bookingId);

      const booking = await bookingsCol.findOne({
        _id: bookingObjectId,
        customerId,
      });

      if (!booking) {
        return res.status(400).json({
          error: "Booking not found or customer mismatch.",
        });
      }

      if (booking.status !== "completed") {
        return res.status(400).json({
          error: "Booking is not completed.",
        });
      }

      const expectedAmount = Math.round(Number(booking.amount) * 100);

      if (
        !Number.isFinite(expectedAmount) ||
        expectedAmount <= 0 ||
        checkoutSession.amount_total !== expectedAmount ||
        checkoutSession.currency?.toLowerCase() !== "bdt"
      ) {
        return res.status(400).json({
          error: "Payment amount or currency mismatch.",
        });
      }

      const transactionId =
        "TXN-" + randomBytes(4).toString("hex").toUpperCase();

      try {
        await paymentsCol.updateOne(
          { stripeSessionId },
          {
            $setOnInsert: {
              bookingId,
              customerId,
              stripeSessionId,
              amount: checkoutSession.amount_total / 100,
              status: "paid",
              paidAt: new Date(),
              transactionId,
            },
          },
          { upsert: true }
        );
      } catch (error) {
        if (error.code !== 11000) {
          throw error;
        }
      }

      await bookingsCol.updateOne(
        {
          _id: bookingObjectId,
          customerId,
        },
        {
          $set: {
            paymentStatus: "paid",
          },
        }
      );

      console.log(`Payment verified for booking ${bookingId}`);

      return res.json({ received: true });
    } catch (error) {
      console.error("Stripe webhook processing failed:", error);

      return res.status(500).json({
        error: "Webhook processing failed.",
      });
    }
  }
);

// ─── General Middleware ─────────────────────────────────────────────────────

app.use(express.json());

// ─── Home Route ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send("Mendizo server is running fine!");
});

// ─── POST Create Technician Service ─────────────────────────────────────────

app.post(
  "/api/technician/services",
  requireTechnician,
  async (req, res) => {
    try {
      const {
        title,
        category,
        description,
        price,
        pricingType,
        duration,
        location,
        imageUrl,
        whatsIncluded,
        requirements,
        status,
      } = req.body;

      if (
        typeof title !== "string" ||
        !title.trim() ||
        typeof category !== "string" ||
        !category.trim() ||
        typeof description !== "string" ||
        !description.trim() ||
        price === undefined ||
        typeof location !== "string" ||
        !location.trim()
      ) {
        return res.status(400).json({
          error: "Please provide all required service information.",
        });
      }

      const servicePrice = Number(price);

      if (!Number.isFinite(servicePrice) || servicePrice <= 0) {
        return res.status(400).json({
          error: "Please provide a valid service price.",
        });
      }

      if (!["fixed", "hourly"].includes(pricingType)) {
        return res.status(400).json({
          error: "Invalid pricing type. Use fixed or hourly.",
        });
      }

      const serviceStatus = status || "published";

      if (!["draft", "published"].includes(serviceStatus)) {
        return res.status(400).json({
          error: "Invalid service status.",
        });
      }

      const service = {
        title: title.trim(),
        category: category.trim(),
        description: description.trim(),
        price: servicePrice,
        pricingType,
        duration: typeof duration === "string" ? duration.trim() : "",
        location: location.trim(),
        imageUrl: typeof imageUrl === "string" ? imageUrl.trim() : "",
        whatsIncluded: Array.isArray(whatsIncluded)
          ? whatsIncluded.filter(
              (item) => typeof item === "string" && item.trim()
            ).map((item) => item.trim())
          : [],
        requirements:
          typeof requirements === "string" ? requirements.trim() : "",

        // Use the authenticated technician's ID.
        technicianId: req.userId,

        status: serviceStatus,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await servicesCol.insertOne(service);

      return res.status(201).json({
        success: true,
        message: "Service created successfully.",
        serviceId: result.insertedId,
      });
    } catch (error) {
      console.error("POST /api/technician/services error:", error);

      return res.status(500).json({
        error: "Unable to create service.",
      });
    }
  }
);

// ─── GET Customer Stats ─────────────────────────────────────────────────────

app.get("/api/customer/stats", requireCustomer, async (req, res) => {
  try {
    const customerQuery = {
      customerId: req.userId,
    };

    const [total, pending, completed] = await Promise.all([
      bookingsCol.countDocuments(customerQuery),

      bookingsCol.countDocuments({
        ...customerQuery,
        status: "requested",
      }),

      bookingsCol.countDocuments({
        ...customerQuery,
        status: "completed",
      }),
    ]);

    res.json({
      total,
      pending,
      completed,
    });
  } catch (error) {
    console.error("GET /api/customer/stats error:", error);

    res.status(500).json({
      error: "Server error",
    });
  }
});

// ─── GET Customer Bookings ──────────────────────────────────────────────────

app.get("/api/customer/bookings", requireCustomer, async (req, res) => {
  try {
    const bookings = await bookingsCol
      .find({ customerId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();

    const enriched = await Promise.all(
      bookings.map(async (booking) => {
        let serviceTitle = "N/A";
        let technicianName = "N/A";

        if (booking.serviceId) {
          const service = await findByIdOrString(
            servicesCol,
            booking.serviceId
          );

          if (service) {
            serviceTitle = service.title || service.name || "N/A";
          }
        }

        if (booking.technicianId) {
          const technician = await usersCol.findOne({
            id: booking.technicianId,
          });

          if (technician) {
            technicianName = technician.name || "N/A";
          }
        }

        return {
          _id: booking._id,
          serviceTitle,
          technicianName,
          preferredDate: booking.preferredDate,
          amount: booking.amount,
          status: booking.status,
          paymentStatus: booking.paymentStatus || "unpaid",
          createdAt: booking.createdAt,
        };
      })
    );

    res.json(enriched);
  } catch (error) {
    console.error("GET /api/customer/bookings error:", error);

    res.status(500).json({
      error: "Server error",
    });
  }
});

// ─── POST Cancel Booking ────────────────────────────────────────────────────

app.post(
  "/api/customer/bookings/:id/cancel",
  requireCustomer,
  async (req, res) => {
    try {
      const bookingId = req.params.id;

      if (!isValidObjectId(bookingId)) {
        return res.status(404).json({
          error: "Booking not found.",
        });
      }

      const bookingObjectId = new ObjectId(bookingId);

      const booking = await bookingsCol.findOne({
        _id: bookingObjectId,
      });

      if (!booking) {
        return res.status(404).json({
          error: "Booking not found.",
        });
      }

      if (booking.customerId !== req.userId) {
        return res.status(403).json({
          error: "Forbidden.",
        });
      }

      if (booking.status !== "requested") {
        return res.status(400).json({
          error: "Only requested bookings can be cancelled.",
        });
      }

      const result = await bookingsCol.updateOne(
        {
          _id: bookingObjectId,
          customerId: req.userId,
          status: "requested",
        },
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(409).json({
          error: "Booking can no longer be cancelled.",
        });
      }

      res.json({
        success: true,
      });
    } catch (error) {
      console.error("POST cancel booking error:", error);

      res.status(500).json({
        error: "Server error",
      });
    }
  }
);

// ─── POST Create Stripe Checkout ────────────────────────────────────────────

app.post("/api/customer/checkout", requireCustomer, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not configured. Add STRIPE_SECRET_KEY to .env.",
      });
    }

    const { bookingId } = req.body;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({
        error: "A valid bookingId is required.",
      });
    }

    const bookingObjectId = new ObjectId(bookingId);

    const booking = await bookingsCol.findOne({
      _id: bookingObjectId,
    });

    if (!booking) {
      return res.status(404).json({
        error: "Booking not found.",
      });
    }

    if (booking.customerId !== req.userId) {
      return res.status(403).json({
        error: "Forbidden.",
      });
    }

    if (booking.status !== "completed") {
      return res.status(400).json({
        error: "Booking must be completed before payment.",
      });
    }

    if ((booking.paymentStatus ?? "unpaid") !== "unpaid") {
      return res.status(400).json({
        error: "This booking is not eligible for payment.",
      });
    }

    const amount = Number(booking.amount);
    const amountInPaisa = Math.round(amount * 100);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isSafeInteger(amountInPaisa) ||
      amountInPaisa <= 0
    ) {
      return res.status(400).json({
        error: "Invalid booking amount.",
      });
    }

    const stripeSession = await stripe.checkout.sessions.create(
      {
        payment_method_types: ["card"],

        line_items: [
          {
            price_data: {
              currency: "bdt",
              product_data: {
                name: "Mendizo Service Booking",
              },
              unit_amount: amountInPaisa,
            },
            quantity: 1,
          },
        ],

        mode: "payment",

        success_url: `${CLIENT_URL}/dashboard/customer/bookings?payment=success`,

        cancel_url: `${CLIENT_URL}/dashboard/customer/bookings?payment=cancelled`,

        metadata: {
          bookingId: bookingObjectId.toString(),
          customerId: req.userId,
        },
      },
      {
        idempotencyKey: `mendizo-booking-${bookingObjectId.toString()}`,
      }
    );

    res.json({
      url: stripeSession.url,
    });
  } catch (error) {
    console.error("POST /api/customer/checkout error:", error);

    res.status(500).json({
      error: "Unable to create checkout session.",
    });
  }
});

// ─── GET Customer Payments ──────────────────────────────────────────────────

app.get("/api/customer/payments", requireCustomer, async (req, res) => {
  try {
    const payments = await paymentsCol
      .find({
        customerId: req.userId,
      })
      .sort({
        paidAt: -1,
      })
      .toArray();

    const enriched = await Promise.all(
      payments.map(async (payment) => {
        let serviceTitle = "N/A";
        let technicianName = "N/A";

        if (payment.bookingId) {
          const booking = await findByIdOrString(
            bookingsCol,
            payment.bookingId
          );

          if (booking) {
            if (booking.serviceId) {
              const service = await findByIdOrString(
                servicesCol,
                booking.serviceId
              );

              if (service) {
                serviceTitle = service.title || service.name || "N/A";
              }
            }

            if (booking.technicianId) {
              const technician = await usersCol.findOne({
                id: booking.technicianId,
              });

              if (technician) {
                technicianName = technician.name || "N/A";
              }
            }
          }
        }

        return {
          _id: payment._id,
          serviceTitle,
          technicianName,
          amount: payment.amount,
          transactionId: payment.transactionId,
          paidAt: payment.paidAt,
          status: payment.status,
        };
      })
    );

    const totalPaid = payments.reduce((sum, payment) => {
      if (payment.status !== "paid") return sum;

      const amount = Number(payment.amount);

      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);

    res.json({
      payments: enriched,
      totalPaid,
    });
  } catch (error) {
    console.error("GET /api/customer/payments error:", error);

    res.status(500).json({
      error: "Server error",
    });
  }
});

// ─── Start Server ───────────────────────────────────────────────────────────

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
