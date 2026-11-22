import "dotenv/config";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { createAuthMiddleware } from "better-auth/api";
import { client, db, connectDb } from "./db.js";

// Make sure the shared client is connected before Better Auth is used.
await connectDb();

const isProduction = process.env.NODE_ENV === "production";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",

  database: mongodbAdapter(db, {
    client,
  }),

  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
  },

  // Google login
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },

  // Trusted client origin
  trustedOrigins: [process.env.CLIENT_URL || "http://localhost:3000"],

  // Cross-domain cookies only in production.
  advanced: isProduction
    ? {
        defaultCookieAttributes: {
          sameSite: "none",
          secure: true,
        },
      }
    : {},

  user: {
    additionalFields: {
      role: {
        type: "string",
        required: true,
        defaultValue: "customer",
        input: true,
      },
      phone: {
        type: "string",
        required: false,
        input: true,
      },
      area: {
        type: "string",
        required: false,
        input: true,
      },
      bio: {
        type: "string",
        required: false,
        input: true,
      },
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email") {
        const role = ctx.body?.role;

        const normalizedRole =
          role === "technician" ? "technician" : "customer";

        return {
          context: {
            ...ctx,
            body: {
              ...ctx.body,
              role: normalizedRole,
            },
          },
        };
      }

      if (ctx.path === "/update-user" && ctx.body) {
        const { role, ...safeBody } = ctx.body;

        return {
          context: {
            ...ctx,
            body: safeBody,
          },
        };
      }
    }),
  },
});