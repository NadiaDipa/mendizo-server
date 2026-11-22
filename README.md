# Mendizo — Backend API Server

**Express.js & MongoDB API Server**

Mendizo's backend API powers the repair-service platform, handling authentication, role-based authorization, service management, booking workflows, payment processing, and administrative operations.

## 🏗️ Architecture & Database Collections

The application uses four primary MongoDB collections:

1. **`users`**: Stores user profiles and roles (`customer`, `technician`, `admin`), integrated with Better Auth.
2. **`services`**: Stores repair service information, approval status (`pending`, `approved`, `rejected`), availability, and category details.
3. **`bookings`**: Stores repair requests and tracks jobs throughout their lifecycle.
4. **`payments`**: Stores Stripe transaction records, including payment status and currency (`usd`).

## 🎯 Core Implementations

### 1. Server-Side Search, Filter & Sort

**Endpoint:** `GET /api/services`

- Server-side text search across `title`, `category`, and `description` using regular expressions.
- Category filtering across seven categories:
  - Smartphone
  - Laptop & PC
  - AC
  - Refrigerator
  - TV
  - Washing Machine
  - Electrical
- Service mode filtering (`Home Visit`, `Shop Drop-off`).
- Server-side sorting:
  - `newest`
  - `price-asc`
  - `price-desc`
- Server-side pagination using `page` and `limit` (25 items per page).
- Returns pagination metadata: `total`, `page`, and `totalPages`.
- Public service visibility is restricted to approved and available services by default.

### 2. Custom Role-Based JWT & Express Middlewares

- **`verifyToken`**: Validates Bearer HMAC-SHA256 JWT tokens and Better Auth session cookies. Missing or invalid authentication returns HTTP 401.
- **`verifyCustomer`**: Restricts access to users with the `customer` role.
- **`verifyTechnician`**: Restricts access to users with the `technician` role.
- **`verifyAdmin`**: Restricts access to users with the `admin` role.
- Unauthorized role access returns HTTP 403.

### 3. Server-Enforced Booking Workflow & Business Logic

Allowed booking status transitions:

| Current Status | Allowed Next Status |
|---|---|
| `requested` | `accepted`, `rejected`, `cancelled` |
| `accepted` | `in-progress` |
| `in-progress` | `completed` |

Additional business rules:

- Completing a booking requires a positive `finalAmount`.
- Technicians can only manage their own assigned repair jobs.
- Customers can only cancel their own bookings while the status is `requested`.
- Duplicate active requests for the same service are prevented while an existing booking is in `requested`, `accepted`, or `in-progress` status.
- Technicians cannot book their own repair services.
- Editing a service resets its approval status to `pending`.
- Admins cannot demote their own accounts.

### 4. Stripe Checkout & Idempotent Payment Processing

- **`POST /api/payments/create-checkout-session`**
  - Allows payment only for completed and unpaid bookings.
  - Retrieves `finalAmount` directly from MongoDB instead of trusting the client-provided amount.
  - Converts the amount into USD cents for Stripe Checkout.

- **`GET /api/payments/verify`**
  - Verifies completed Stripe Checkout sessions.
  - Records payment information idempotently to prevent duplicate payment records.

- **`POST /api/stripe/webhook`**
  - Uses Express raw body parsing with `express.raw`.
  - Verifies Stripe webhook signatures using `stripe.webhooks.constructEvent`.
  - Handles `checkout.session.completed` events with idempotent payment processing.

## 🛠️ Tech Stack

| Category | Technologies |
|---|---|
| Runtime | Node.js |
| Framework | Express.js |
| Middleware | CORS, Cookie Parser |
| Database | MongoDB Atlas |
| Authentication | Better Auth, JWT |
| Payment Gateway | Stripe |
| Environment Configuration | Dotenv |

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone <your-server-repository-url>
cd mendizo-server
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
BETTER_AUTH_SECRET=your_better_auth_secret
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret
CLIENT_URL=http://localhost:3000
```

### 4. Seed the Database

```bash
node seed.js
```

The seed script populates the database with demo users, services, and sample bookings.

### 5. Start the API Server

```bash
node index.js
```

The backend API runs at:

[http://localhost:5000](http://localhost:5000)

## 🔑 Seed Demo Accounts

The seed script provides demo accounts for testing the different user roles.

| Role | Demo Email |
|---|---|
| Admin | `admin@mendizo.com` |
| Technician | `rafiqul.tech@mendizo.com` |
| Technician | `tanvir.tech@mendizo.com` |
| Technician | `sumon.tech@mendizo.com` |
| Customer | `customer@mendizo.com` |

Demo passwords should be shared separately, not committed to a public repository.

## 🔒 Security Notes

- Keep `.env` files and all API keys private.
- Never expose Stripe secret keys or webhook secrets in client-side code.
- Validate authentication, user roles, and resource ownership on the server.
- Never trust payment amounts supplied by the client.
- Verify Stripe webhook signatures before processing payment events.

---

**Mendizo — Making Home Repairs Easier.**