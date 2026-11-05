/**
 * Reserved WebSocket transport. V1 intentionally ships HTTP long-polling over
 * the existing SSH tunnel; this stub documents the swap point and fails
 * loudly instead of pretending to work.
 */

import { Transport } from './transport.js';

export class WebSocketTransport extends Transport {
  constructor() {
    super();
    throw new Error('WebSocket transport is not implemented in v1; use transport "http-long-poll"');
  }

  get name() {
    return 'websocket';
  }
}
