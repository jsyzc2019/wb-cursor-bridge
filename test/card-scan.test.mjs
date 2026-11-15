/**
 * P4 acceptance: the Agent Card scanner must be a working gate, not decoration.
 *
 * Every test feeds scanCardPair() the same pure function the CI step uses, so
 * a regression in the scanner is caught here. The final case additionally
 * validates the REAL production cards from dist/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanCardPair, buildProductionCards, BINDINGS } from '../scripts/scan-card.mjs';

function legacyCard(overrides = {}) {
  return {
    protocolVersion: '0.3.0',
    name: 'wb-cursor-bridge',
    description: 'governed sub-agent',
    version: '0.6.2',
    skills: [{ id: 'cursor.run', name: 'Run' }],
    capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
    ...overrides,
  };
}

function v1Card(overrides = {}) {
  return {
    name: 'wb-cursor-bridge',
    description: 'governed sub-agent',
    version: '0.6.2',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'cursor.run', name: 'Run' }],
    supportedInterfaces: [
      { url: 'http://127.0.0.1:1234/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    ...overrides,
  };
}

const messages = (r) => r.findings.map((f) => f.message).join('\n');

test('card-scan: a well-formed card pair passes the gate', () => {
  const r = scanCardPair(legacyCard(), v1Card());
  assert.equal(r.ok, true, messages(r));
  assert.deepEqual(r.findings, []);
});

test('card-scan: missing supportedInterfaces is caught (TCK BIND-FIELD-001)', () => {
  const v1 = v1Card();
  delete v1.supportedInterfaces;
  const r = scanCardPair(legacyCard(), v1);
  assert.equal(r.ok, false);
  assert.match(messages(r), /supportedInterfaces must be a non-empty array/);
});

test('card-scan: v0.3-only fields leaking into the v1.0 card are caught', () => {
  const r = scanCardPair(legacyCard(), v1Card({ protocolVersion: '1.0', preferredTransport: 'HTTP/json' }));
  assert.equal(r.ok, false);
  assert.match(messages(r), /v0.3-only field "protocolVersion"/);
  assert.match(messages(r), /v0.3-only field "preferredTransport"/);
});

test('card-scan: non-standard protocolBinding is caught', () => {
  const v1 = v1Card({
    supportedInterfaces: [{ url: 'http://host/a2a', protocolBinding: 'AMQP', protocolVersion: '1.0' }],
  });
  const r = scanCardPair(legacyCard(), v1);
  assert.equal(r.ok, false);
  assert.match(messages(r), /unsupported protocolBinding "AMQP"/);
});

test('card-scan: duplicate bindings are caught', () => {
  const v1 = v1Card({
    supportedInterfaces: [
      { url: 'http://host/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'http://host/rest', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
  });
  const r = scanCardPair(legacyCard(), v1);
  assert.equal(r.ok, false);
  assert.match(messages(r), /duplicate protocolBinding "JSONRPC"/);
});

test('card-scan: all three A2A v1.0 bindings are recognised', () => {
  assert.deepEqual([...BINDINGS].sort(), ['GRPC', 'HTTP+JSON', 'JSONRPC']);
  const v1 = v1Card({
    supportedInterfaces: [
      { url: 'http://host/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'http://host/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      { url: 'http://host/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' },
    ],
  });
  assert.equal(scanCardPair(legacyCard(), v1).ok, true);
});

test('card-scan: over-claiming pushNotifications is an error, not a warning', () => {
  const r = scanCardPair(
    legacyCard({ capabilities: { streaming: true, pushNotifications: false } }),
    v1Card({ capabilities: { streaming: true, pushNotifications: true } }),
  );
  assert.equal(r.ok, false);
  assert.match(messages(r), /no push delivery contract/);
});

test('card-scan: streaming capability disagreement is caught', () => {
  const r = scanCardPair(legacyCard(), v1Card({ capabilities: { streaming: false, pushNotifications: false } }));
  assert.equal(r.ok, false);
  assert.match(messages(r), /streaming capability disagrees/);
});

test('card-scan: wildcard host and non-http scheme are caught', () => {
  const r = scanCardPair(
    legacyCard(),
    v1Card({
      supportedInterfaces: [
        { url: 'file:///etc/passwd', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url: 'http://0.0.0.0:1234/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      ],
    }),
  );
  assert.equal(r.ok, false);
  assert.match(messages(r), /must be http\(s\)/);
  assert.match(messages(r), /wildcard\/empty host/);
});

test('card-scan: unknown skill fields and unknown capabilities are caught', () => {
  const r = scanCardPair(
    legacyCard(),
    v1Card({
      skills: [{ id: 's', name: 'S', kind: 'leaked' }],
      capabilities: { streaming: true, pushNotifications: false, telemetry: true },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(messages(r), /skill field "kind"/);
  assert.match(messages(r), /unknown capability "telemetry"/);
});

test('card-scan: extendedAgentCard declaration is surfaced as a warning', () => {
  const r = scanCardPair(
    legacyCard(),
    v1Card({ capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: true } }),
  );
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => /GetExtendedAgentCard must be implemented/.test(n.message)));
});

test('card-scan: the REAL production cards pass the gate', async () => {
  const { legacy, v1 } = await buildProductionCards();
  const r = scanCardPair(legacy, v1);
  assert.equal(r.ok, true, messages(r));
  assert.equal(v1.supportedInterfaces[0].protocolBinding, 'JSONRPC');
});
