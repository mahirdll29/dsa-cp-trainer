import { PrismaClient } from "@prisma/client";

// One shared client for the whole process — creating a PrismaClient per request
// would open a new connection pool each time and exhaust the database.
const prisma = new PrismaClient();

export default prisma;