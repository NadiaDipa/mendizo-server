import "dotenv/config";
import { MongoClient } from "mongodb";

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required.");
}

export const client = new MongoClient(process.env.MONGODB_URI, {
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 10000,
});

export const db = client.db("mendizo");

let connectPromise = null;

// Connect once and reuse the same promise on every call.
export function connectDb() {
  if (!connectPromise) {
    connectPromise = client.connect().catch((err) => {
      connectPromise = null;
      throw err;
    });
  }
  return connectPromise;
}