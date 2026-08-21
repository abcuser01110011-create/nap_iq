import * as SecureStore from "expo-secure-store";
import type { TokenPair, TokenStorage } from "@nap-iq/api-client";

/**
 * Backs the shared ApiClient's TokenStorage interface with
 * expo-secure-store (Keychain on iOS, Keystore-backed
 * EncryptedSharedPreferences on Android) — never AsyncStorage, since
 * these are auth tokens.
 *
 * This is a single installable app now (one technician OR customer
 * account signed in at a time, same as before — just no longer two
 * separate installs), so there's no need for the "technician_" /
 * "customer_" key prefixes the two standalone apps used to avoid
 * collisions with each other.
 */
const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";

export const secureTokenStorage: TokenStorage = {
  async getTokens(): Promise<TokenPair | null> {
    const [accessToken, refreshToken] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_KEY),
      SecureStore.getItemAsync(REFRESH_KEY),
    ]);
    if (!accessToken || !refreshToken) return null;
    return { accessToken, refreshToken };
  },

  async setTokens(tokens: TokenPair): Promise<void> {
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
      SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
    ]);
  },

  async setAccessToken(accessToken: string): Promise<void> {
    await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
  },

  async clear(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY),
      SecureStore.deleteItemAsync(REFRESH_KEY),
    ]);
  },
};
