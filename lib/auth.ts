import { NextAuthOptions, getServerSession } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import { compare } from 'bcryptjs';
import prisma from './prisma';

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
  pages: {
    signIn:  '/auth/login',
    newUser: '/auth/register',
  },
  providers: [
    CredentialsProvider({
      name: 'Email',
      credentials: {
        email:    { label: 'Email',    type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const user = await prisma.user.findUnique({ where: { email: credentials.email } });
        if (!user || !user.passwordHash) return null;
        const valid = await compare(credentials.password, user.passwordHash);
        if (!valid) return null;
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? [
      GoogleProvider({
        clientId:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        async profile(profile) {
          return { id: profile.sub, email: profile.email, name: profile.name };
        },
      }),
    ] : []),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === 'google') {
        const existing = await prisma.user.findUnique({ where: { email: user.email! } });
        if (!existing) {
          const newUser = await prisma.user.create({
            data: { email: user.email!, name: user.name, googleId: account.providerAccountId },
          });
          await prisma.userPreferences.create({ data: { userId: newUser.id } });
          await prisma.portfolio.create({ data: { userId: newUser.id } });
        } else if (!existing.googleId) {
          await prisma.user.update({ where: { id: existing.id }, data: { googleId: account.providerAccountId } });
        }
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) token.id = user.id;
      if (!token.id && token.email) {
        const dbUser = await prisma.user.findUnique({ where: { email: token.email } });
        if (dbUser) token.id = dbUser.id;
      }
      // Role always comes from the DB row, never from the client-supplied token.
      if (token.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { role: true },
        });
        token.role = dbUser?.role ?? 'user';
      }
      return token;
    },
    async session({ session, token }) {
      if (token.id) session.user.id = token.id as string;
      session.user.role = (token.role as string) ?? 'user';
      return session;
    },
  },
};

export async function getUser() {
  const session = await getServerSession(authOptions);
  return session?.user ?? null;
}
