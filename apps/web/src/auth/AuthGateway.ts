export interface AuthIdentity {
  readonly userId: string;
  readonly email: string;
  readonly expiresAt: number;
}

export interface AuthResult {
  readonly ok: boolean;
  readonly message?: string;
}

/**
 * The narrow authentication surface the session store depends on. One adapter
 * ({@link BetterAuthGateway}) wraps the real better-auth client; tests use a
 * fake. The store never imports better-auth/client directly.
 */
export interface AuthGateway {
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(email: string, password: string, name: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  currentIdentity(): Promise<AuthIdentity | null>;
}
