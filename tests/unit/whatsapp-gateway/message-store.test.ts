import { describe, it, expect } from 'vitest';
import { MessageStore, messageStoreKey } from '#src/whatsapp-gateway/messages/message-store.js';
import type { WAMessage } from '@whiskeysockets/baileys';

const GROUP = '120363000000000000@g.us';

function textMessage(id: string, text: string, remoteJid = GROUP): WAMessage {
  const msg: WAMessage = {
    key: { remoteJid, id, fromMe: true },
    message: { conversation: text },
  };
  return msg;
}

function pollMessage(id: string, secret: Uint8Array, options: string[]): WAMessage {
  const msg: WAMessage = {
    key: { remoteJid: GROUP, id, fromMe: true },
    message: {
      messageContextInfo: { messageSecret: secret },
      pollCreationMessage: { name: 'Q?', options: options.map((name) => ({ optionName: name })) },
    },
  };
  return msg;
}

describe('MessageStore (research.md §2/§7)', () => {
  it('returns the message content for getMessage (send-retry path), undefined on a miss', () => {
    const store = new MessageStore();
    store.set(textMessage('A', 'hello'));
    expect(store.getMessage(messageStoreKey(GROUP, 'A'))?.conversation).toBe('hello');
    expect(store.getMessage(messageStoreKey(GROUP, 'missing'))).toBeUndefined();
  });

  it('returns the full poll-creation message via getByPollId (poll-secret fast-path)', () => {
    const store = new MessageStore();
    const secret = new Uint8Array([1, 2, 3, 4]);
    store.set(pollMessage('POLL1', secret, ['Yes', 'No']));
    const cached = store.getByPollId(GROUP, 'POLL1');
    expect(cached?.message?.messageContextInfo?.messageSecret).toEqual(secret);
    expect(cached?.message?.pollCreationMessage?.options?.length).toBe(2);
  });

  it('ignores a message without a usable key', () => {
    const store = new MessageStore();
    const noKey: WAMessage = { message: { conversation: 'x' } };
    store.set(noKey);
    expect(store.size).toBe(0);
  });

  it('delete removes an entry', () => {
    const store = new MessageStore();
    store.set(textMessage('A', 'hello'));
    store.delete(messageStoreKey(GROUP, 'A'));
    expect(store.getMessage(messageStoreKey(GROUP, 'A'))).toBeUndefined();
  });

  it('evicts the least-recently-used entry when over capacity', () => {
    const store = new MessageStore(2);
    store.set(textMessage('A', 'a'));
    store.set(textMessage('B', 'b'));
    store.set(textMessage('C', 'c')); // evicts A (oldest)
    expect(store.size).toBe(2);
    expect(store.getMessage(messageStoreKey(GROUP, 'A'))).toBeUndefined();
    expect(store.getMessage(messageStoreKey(GROUP, 'B'))?.conversation).toBe('b');
    expect(store.getMessage(messageStoreKey(GROUP, 'C'))?.conversation).toBe('c');
  });

  it('a read bumps recency so the touched entry survives eviction', () => {
    const store = new MessageStore(2);
    store.set(textMessage('A', 'a'));
    store.set(textMessage('B', 'b'));
    // Touch A so it becomes most-recently-used; B is now the LRU.
    store.getMessage(messageStoreKey(GROUP, 'A'));
    store.set(textMessage('C', 'c')); // evicts B
    expect(store.getMessage(messageStoreKey(GROUP, 'B'))).toBeUndefined();
    expect(store.getMessage(messageStoreKey(GROUP, 'A'))?.conversation).toBe('a');
  });
});

describe('MessageStore.claimOnce (test-and-set; backs at-most-once dispatch, FR-034)', () => {
  it('returns true the first time a key is claimed', () => {
    const store = new MessageStore();
    expect(store.claimOnce(messageStoreKey(GROUP, 'M1'))).toBe(true);
  });

  it('returns false on a second claim of the same key', () => {
    const store = new MessageStore();
    const key = messageStoreKey(GROUP, 'M1');
    expect(store.claimOnce(key)).toBe(true);
    expect(store.claimOnce(key)).toBe(false);
  });

  it('claims two distinct keys independently', () => {
    const store = new MessageStore();
    expect(store.claimOnce(messageStoreKey(GROUP, 'M1'))).toBe(true);
    expect(store.claimOnce(messageStoreKey(GROUP, 'M2'))).toBe(true);
  });

  it('evicts the oldest claim past maxSize, making it re-claimable', () => {
    const store = new MessageStore(2);
    expect(store.claimOnce(messageStoreKey(GROUP, 'M1'))).toBe(true);
    expect(store.claimOnce(messageStoreKey(GROUP, 'M2'))).toBe(true);
    // Claiming a third distinct key evicts the oldest (M1); tracked set is now {M2, M3}.
    expect(store.claimOnce(messageStoreKey(GROUP, 'M3'))).toBe(true);
    // M2 is still tracked (a re-claim is a no-op, no recency bump).
    expect(store.claimOnce(messageStoreKey(GROUP, 'M2'))).toBe(false);
    // M1 was evicted, so it claims fresh as true again.
    expect(store.claimOnce(messageStoreKey(GROUP, 'M1'))).toBe(true);
  });
});

describe('own-send claim semantics (echo suppression — contract C2, FR-004/FR-006/US3)', () => {
  // At send time the Gateway pre-populates the at-most-once guard for its own (group, id)
  // (T005, right after messageStore.set(sent)). The dispatch decision (C1.2) then suppresses
  // the echo when it arrives — live or on reconnect. These tests pin the claimOnce semantics
  // that the own-send claim relies on, framed as the C2 guarantees.

  it('suppresses the Gateway’s own echo: re-claiming the sent (group, id) returns false (G5)', () => {
    const store = new MessageStore();
    // Send time: the Gateway claims its own programmatic send.
    expect(store.claimOnce(messageStoreKey(GROUP, 'SENT1'))).toBe(true);
    // The echo of that same send re-claims the SAME key → suppressed, not dispatched.
    expect(store.claimOnce(messageStoreKey(GROUP, 'SENT1'))).toBe(false);
  });

  it('dispatches a manual operator send: an id the Gateway never claimed → true (G6, FR-006)', () => {
    const store = new MessageStore();
    // The Gateway claimed its own programmatic send…
    store.claimOnce(messageStoreKey(GROUP, 'SENT1'));
    // …but a message the operator typed on their linked phone has an id the Gateway never
    // claimed, so it claims fresh and is dispatched as genuine inbound activity (never gated
    // on fromMe — keyed to the Gateway's own send id).
    expect(store.claimOnce(messageStoreKey(GROUP, 'MANUAL1'))).toBe(true);
  });

  it('keys the claim by chat (remoteJid + id), so sender PN/LID addressing is irrelevant (G7)', () => {
    // messageStoreKey composes only (remoteJid, id) — the sender participant never enters the
    // key — so the echo matches the send regardless of how the sender is addressed (PN vs LID).
    expect(messageStoreKey(GROUP, 'SENT1')).toBe(`${GROUP}:SENT1`);
    const store = new MessageStore();
    expect(store.claimOnce(messageStoreKey(GROUP, 'SENT1'))).toBe(true);
    // Same chat + id, whatever the echo's sender addressing → same key → suppressed.
    expect(store.claimOnce(messageStoreKey(GROUP, 'SENT1'))).toBe(false);
  });
});
