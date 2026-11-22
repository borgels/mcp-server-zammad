import { ActAsRefusedError } from '../act-as.js';
import type { ZammadClient } from './client.js';
import { currentActAs } from './scope.js';

/** How many users a lookup reads; more than one exact match is refused anyway. */
const LOOKUP_LIMIT = 50;

/**
 * The client a change is made with. Without a person from the host (actAs), the token's own client. With one, a copy
 * that acts as the person's own Zammad user (`From: <id>`), found by the verified email as the token's user: exactly one
 * active user whose email is that address, compared case-insensitively. None, or more than one, is
 * ActAsRefusedError('no_user'), and nothing is sent: a change is never made as the token's own user instead.
 *
 * The email goes to Zammad only as the search; it is not kept, audited or returned.
 */
export async function clientForChange(client: ZammadClient): Promise<ZammadClient> {
  const person = currentActAs();
  if (!person) return client;
  const found = await client.get<unknown>('/users/search', { query: person.email, limit: LOOKUP_LIMIT });
  const ids = (Array.isArray(found) ? found : [])
    .filter((user): user is Record<string, unknown> => user !== null && typeof user === 'object' && !Array.isArray(user))
    .filter(user => typeof user.email === 'string' && user.email.trim().toLowerCase() === person.email && user.active === true)
    .map(user => user.id)
    .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
  if (ids.length !== 1) throw new ActAsRefusedError('no_user');
  return client.asUser(ids[0]!);
}
