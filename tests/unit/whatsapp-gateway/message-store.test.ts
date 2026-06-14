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
