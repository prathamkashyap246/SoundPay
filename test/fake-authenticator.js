// A software passkey (like a phone's fingerprint sensor, minus the finger) so the
// tests can run the real WebAuthn verification end to end without a browser.
import crypto from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64url = buf => Buffer.from(buf).toString('base64url');
const sha256 = data => crypto.createHash('sha256').update(data).digest();

export class FakeAuthenticator {
  constructor(origin) {
    this.origin = origin;
    this.rpID = new URL(origin).hostname;
    this.keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.credentialId = crypto.randomBytes(16);
    this.counter = 0;
  }

  authData(flags, extra = Buffer.alloc(0)) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(this.rpID), Buffer.from([flags]), count, extra]);
  }

  // Answer to navigator.credentials.create()
  register(options) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const coseKey = isoCBOR.encode(new Map([
      [1, 2], [3, -7], [-1, 1],                       // EC2, ES256, P-256
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]));
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, Buffer.from(coseKey)]);

    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin });
    const attestationObject = isoCBOR.encode(new Map([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(0x45, attested)],   // UP + UV + AT
    ]));
    return {
      id: b64url(this.credentialId), rawId: b64url(this.credentialId), type: 'public-key',
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
    };
  }

  // Answer to navigator.credentials.get()
  sign(options) {
    this.counter += 1;
    const authenticatorData = this.authData(0x05);                                          // UP + UV
    const clientData = JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin });
    const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, sha256(clientData)]), this.keys.privateKey);
    return {
      id: b64url(this.credentialId), rawId: b64url(this.credentialId), type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}
