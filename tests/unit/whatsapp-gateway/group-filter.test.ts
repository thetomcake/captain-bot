import { describe, it, expect } from 'vitest';
import { GroupFilter } from '#src/whatsapp-gateway/groups/group-filter.js';

const AUTHORIZED = '120363000000000000@g.us';
const OTHER_GROUP = '120363999999999999@g.us';
const PN_USER = '12345678901@s.whatsapp.net';
const LID_USER = '98765@lid';

describe('GroupFilter (FR-017/FR-018)', () => {
  const filter = new GroupFilter([AUTHORIZED]);

  it('accepts the configured authorized group', () => {
    expect(filter.isAuthorized(AUTHORIZED)).toBe(true);
  });

  it('rejects a different (unauthorized) group', () => {
    expect(filter.isAuthorized(OTHER_GROUP)).toBe(false);
  });

  it('rejects a direct-message / user JID even though it is a chat', () => {
    expect(filter.isAuthorized(PN_USER)).toBe(false);
    expect(filter.isAuthorized(LID_USER)).toBe(false);
  });

  it('rejects the status broadcast and newsletters', () => {
    expect(filter.isAuthorized('status@broadcast')).toBe(false);
    expect(filter.isAuthorized('123456@newsletter')).toBe(false);
  });

  it('rejects undefined / empty input without throwing', () => {
    expect(filter.isAuthorized(undefined)).toBe(false);
    expect(filter.isAuthorized('')).toBe(false);
  });

  it('supports multiple authorized groups', () => {
    const multi = new GroupFilter([AUTHORIZED, OTHER_GROUP]);
    expect(multi.isAuthorized(AUTHORIZED)).toBe(true);
    expect(multi.isAuthorized(OTHER_GROUP)).toBe(true);
    expect(multi.isAuthorized('120363111111111111@g.us')).toBe(false);
  });
});
