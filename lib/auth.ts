import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';

const DB_PATH = path.join(process.cwd(), 'data', 'users.db');

export const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'pm-arb-secret-key-change-in-prod-2024x'
);

export type UserRole = 'free' | 'pro' | 'admin';

export interface User {
  id: number;
  email: string;
  role: UserRole;
  created_at: string;
}

export interface UserRow extends User {
  password: string;
}

export function openUsersDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password   TEXT    NOT NULL,
      role       TEXT    NOT NULL DEFAULT 'free',
      created_at TEXT    NOT NULL
    );
  `);
  return db;
}

export function ensureAdmin(): void {
  const db = openUsersDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get('gasparatodiego@gmail.com');
  if (!existing) {
    const hash = bcrypt.hashSync('Admin123!', 10);
    db.prepare('INSERT INTO users (email, password, role, created_at) VALUES (?, ?, ?, ?)').run(
      'gasparatodiego@gmail.com', hash, 'admin', new Date().toISOString()
    );
  }
  db.close();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function signToken(user: User): Promise<string> {
  return new SignJWT({ email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<{ sub: string; email: string; role: UserRole } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as { sub: string; email: string; role: UserRole };
  } catch {
    return null;
  }
}

export function getUserByEmail(email: string): UserRow | null {
  const db = openUsersDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) as UserRow | undefined;
  db.close();
  return user ?? null;
}

export function getUserById(id: number): User | null {
  const db = openUsersDb();
  const user = db.prepare('SELECT id, email, role, created_at FROM users WHERE id = ?').get(id) as User | undefined;
  db.close();
  return user ?? null;
}

export function createUser(email: string, passwordHash: string): User {
  const db = openUsersDb();
  const result = db.prepare('INSERT INTO users (email, password, role, created_at) VALUES (?, ?, ?, ?)').run(
    email, passwordHash, 'free', new Date().toISOString()
  );
  const user = db.prepare('SELECT id, email, role, created_at FROM users WHERE id = ?').get(result.lastInsertRowid) as User;
  db.close();
  return user;
}

export function getAllUsers(): User[] {
  const db = openUsersDb();
  const users = db.prepare('SELECT id, email, role, created_at FROM users ORDER BY created_at DESC').all() as User[];
  db.close();
  return users;
}

export function setUserRole(id: number, role: UserRole): void {
  const db = openUsersDb();
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  db.close();
}
