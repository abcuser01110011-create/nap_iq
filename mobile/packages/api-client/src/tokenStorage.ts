/**
 * ApiClient doesn't know or care how tokens are persisted — each app
 * supplies its own implementation (both apps use expo-secure-store,
 * see apps//src/auth/secureTokenStorage.ts) so this package stays
 * usable outside Expo too (tests, a future web admin client, etc).
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStorage {
  getTokens(): Promise<TokenPair | null>;
  setTokens(tokens: TokenPair): Promise<void>;
  setAccessToken(accessToken: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory fallback — tokens don't survive an app restart. Useful
 * for tests/tooling; the real apps always pass a SecureStore-backed
 * implementation instead. */
export class InMemoryTokenStorage implements TokenStorage {
  private tokens: TokenPair | null = null;

  async getTokens(): Promise<TokenPair | null> {
    return this.tokens;
  }

  async setTokens(tokens: TokenPair): Promise<void> {
    this.tokens = tokens;
  }

  async setAccessToken(accessToken: string): Promise<void> {
    if (this.tokens) {
      this.tokens = { ...this.tokens, accessToken };
    }
  }

  async clear(): Promise<void> {
    this.tokens = null;
  }
}
