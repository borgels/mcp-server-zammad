import { ActAsRefusedError } from '../act-as.js';
import type { ZammadClient } from './client.js';
import { currentActAs } from './scope.js';

/**
 * How many users a lookup asks for. A page that comes back full may have left out a second
 * user with the same email (Zammad can allow that), so a full page is refused: uniqueness is only accepted when the
 * whole result was read.
 */
export const LOOKUP_LIMIT = 100;

/**
 * The client a change is made with. Without a person from the host (actAs), the token's own client. With one, a copy
 * that acts as the person's own Zammad user (`From: <id>`), found by the verified email as the token's user: exactly one
 * active user whose email is that address, compared case-insensitively, in a result Zammad gave whole (fewer than
 * LOOKUP_LIMIT users). None, more than one, or a result that may have been cut short is
 * ActAsRefusedError('no_user'), and nothing is sent: a change is never made as the token's own user instead.
 *
 * The email goes to Zammad only as the search; it is not kept, audited or returned.
 */
export async function clientForChange(client: ZammadClient): Promise<ZammadClient> {
  const person = currentActAs();
  if (!person) return client;
  const found = await client.get<unknown>('/users/search', { query: person.email, limit: LOOKUP_LIMIT });
  if (!Array.isArray(found) || found.length >= LOOKUP_LIMIT) throw new ActAsRefusedError('no_user');
  const ids = found
    .filter((user): user is Record<string, unknown> => user !== null && typeof user === 'object' && !Array.isArray(user))
    .filter(user => typeof user.email === 'string' && user.email.trim().toLowerCase() === person.email && user.active === true)
    .map(user => user.id)
    .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
  if (ids.length !== 1) throw new ActAsRefusedError('no_user');
  return client.asUser(ids[0]!);
}
