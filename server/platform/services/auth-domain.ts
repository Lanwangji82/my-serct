import { login, requireUser } from '../../auth-service';

export async function loginPlatformUser(email: string, password: string) {
  return login(email, password);
}

export async function requirePlatformUser(token?: string) {
  return requireUser(token);
}
