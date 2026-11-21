# Mendizo — Backend API Server

Express.js & MongoDB API server powering Mendizo (Category 006).

---

## 🏗️ Architecture & Collections

The server operates on exactly 4 application-level MongoDB collections:
1. `users`: Stores user profile and role (`customer`, `technician`, `admin`), integrated with BetterAuth.
2. `services`: Stores repair services with approval status (`pending`, `approved`, `rejected`), availability toggle, and category classification.
3. `bookings`: Stores repair jobs throughout their lifecycle with strict pipeline enforcement.
4. `payments`: Stores idempotent Stripe transaction records with currency `usd` and payment status `paid`.

---

## 🎯 Implementation of Assignment Challenges

### Challenge 1: Server-Side Search, Filter & Sort (`GET /api/services`)
- Server-side text search across `title`, `category`, and `description` via regex.
- Multi-category matching for the 7 assignment categories (`Smartphone`, `Laptop & PC`, `AC`, `Refrigerator`, `TV`, `Washing Machine`, `Electrical`).
- Service mode filtering (`Home Visit`, `Shop Drop-off`).
- Server-side sorting (`newest`, `price-asc`, `price-desc`).
- Server-side pagination (`page`, `limit=25`, returning `total`, `page`, `totalPages`).
- Strict visibility filter: `{ approvalStatus: "approved", isAvailable: true }`.

### Challenge 2: Custom Role & JWT Express Middlewares
- `verifyToken`: Validates Bearer HMAC-SHA256 JWT tokens and BetterAuth session cookies. Missing or invalid tokens return HTTP 401.
- `verifyCustomer`: Enforces `req.user.role === "customer"`. Unauthorized roles return HTTP 403.
- `verifyTechnician`: Enforces `req.user.role === "technician"`. Unauthorized roles return HTTP 403.
- `verifyAdmin`: Enforces `req.user.role === "admin"`. Unauthorized roles return HTTP 403.

### Challenge 3: Server-Enforced Job Status Pipeline & Business Logic
- Allowed transitions only:
  - `requested` → `accepted` or `rejected` or `cancelled`
  - `accepted` → `in-progress`
  - `in-progress` → `completed` (requires positive `finalAmount > 0`)
- Ownership enforcement: Technicians can only act on their own assigned jobs; customers can only cancel their own requested bookings.
- Duplicate active request prevention: A customer cannot submit another request for the same service while in `['requested', 'accepted', 'in-progress']`.
- Self-booking prevention: A technician cannot request their own repair service.
- Editing a service automatically resets `approvalStatus: "pending"`.
- Admin cannot demote their own account.

### Challenge 4: Stripe Checkout & Idempotent Webhook
- `POST /api/payments/create-checkout-session`: Enforces status gate (`status === 'completed'` and `paymentStatus === 'unpaid'`). Loads `finalAmount` directly from MongoDB (never trusts client amount) in USD cents.
- `GET /api/payments/verify`: Idempotent payment verification and recording to prevent double payments.
- `POST /api/stripe/webhook`: Express raw body parser (`express.raw`), cryptographic signature verification via `stripe.webhooks.constructEvent`, handling `checkout.session.completed` events idempotently.

---

## 🛠️ Tech Stack & Dependencies

- **Runtime**: Node.js
- **Server Framework**: Express.js (`express`, `cors`, `cookie-parser`)
- **Database**: MongoDB Atlas (`mongodb`)
- **Authentication**: BetterAuth (`better-auth`)
- **Payment Gateway**: Stripe SDK (`stripe`)
- **Environment**: Dotenv (`dotenv`)

---

## 🚀 Getting Started

### 1. Environment Setup

Create a `.env` file in `mendizo-server/`:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
BETTER_AUTH_SECRET=your_better_auth_secret_here
STRIPE_SECRET_KEY=your_stripe_secret_key_here
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret_here
CLIENT_URL=http://localhost:3000
```

### 2. Install & Seed

```bash
# Install dependencies
npm install

# Seed Admin, Technicians, Customer, 14 Services, and Sample Bookings
node seed.js

# Start API server
node index.js
```

Server runs on [http://localhost:5000](http://localhost:5000).

---

## 🔑 Seed Test Accounts

- **Admin**: `admin@mendizo.com` / `admin@fixmate.com` (Password: `Admin@1234`)
- **Technicians**:
  - `rafiqul.tech@mendizo.com` / `rafiqul.tech@fixmate.com` (Password: `Tech@1234`)
  - `tanvir.tech@mendizo.com` / `tanvir.tech@fixmate.com` (Password: `Tech@1234`)
  - `sumon.tech@mendizo.com` / `sumon.tech@fixmate.com` (Password: `Tech@1234`)
- **Customer**: `customer@mendizo.com` / `customer@fixmate.com` (Password: `Cust@1234`)
