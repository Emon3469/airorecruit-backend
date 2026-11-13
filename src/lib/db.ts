import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from './logger';

export async function connectDb(uri = env.MONGO_URI): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  // Make sure the unique indexes that implement dedupe and idempotency exist
  // before any worker starts writing.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  logger.info('mongo connected');
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
