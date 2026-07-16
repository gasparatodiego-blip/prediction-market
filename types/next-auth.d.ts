import 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id:    string;
      email: string;
      name?: string | null;
      role:  string;   // 'user' | 'admin' — sourced from the User row, never the client
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?:   string;
    role?: string;
  }
}
