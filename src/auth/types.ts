/** Identity kept from Discord's /users/@me. Nothing else about the user is stored. */
export interface AuthUser {
  id: string;
  username: string;
  globalName: string;
  /** Avatar hash, or "" when the user has none. */
  avatar: string;
}

export type AuthEnv = { Variables: { user: AuthUser | null } };
