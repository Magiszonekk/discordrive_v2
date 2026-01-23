import {
  createContext,
  useContext,
  useState,
  useEffect,
  PropsWithChildren,
} from 'react';
import * as SecureStore from 'expo-secure-store';
import { galleryApi, setAuthToken } from '@/lib/api/client';
import { storeEncryptionKey, clearEncryptionKey, decryptKeyWithPassword } from '@/lib/crypto/keys';

const TOKEN_KEY = 'discordrive_auth_token';
const USER_KEY = 'discordrive_user';

interface User {
  id: number;
  username: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load stored auth on mount
  useEffect(() => {
    loadStoredAuth();
  }, []);

  async function loadStoredAuth() {
    try {
      const storedToken = await SecureStore.getItemAsync(TOKEN_KEY);
      const storedUser = await SecureStore.getItemAsync(USER_KEY);

      if (storedToken && storedUser) {
        setToken(storedToken);
        setAuthToken(storedToken);
        setUser(JSON.parse(storedUser));
      }
    } catch (error) {
      console.error('Failed to load stored auth:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function login(email: string, password: string) {
    const response = await galleryApi.login(email, password);

    if (!response.success || !response.token || !response.user) {
      throw new Error(response.message || 'Login failed');
    }

    // Store token
    await SecureStore.setItemAsync(TOKEN_KEY, response.token);
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(response.user));
    setToken(response.token);
    setAuthToken(response.token);
    setUser(response.user);

    // Handle cloud key sync if available
    if (response.encryptedKey && response.encryptedKeySalt) {
      try {
        const decryptedKey = await decryptKeyWithPassword(
          response.encryptedKey,
          response.encryptedKeySalt,
          password
        );
        await storeEncryptionKey(decryptedKey);
      } catch (error) {
        console.error('Failed to decrypt cloud key:', error);
        // Don't fail login if key sync fails
      }
    }
  }

  async function logout() {
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(USER_KEY);
      await clearEncryptionKey();
    } catch (error) {
      console.error('Failed to clear stored data:', error);
    }

    setToken(null);
    setAuthToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!token && !!user,
        isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
