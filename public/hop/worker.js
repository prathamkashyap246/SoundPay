// Web Worker: hop decoding off the main thread, so the UI and the audio callback never stall.
import { createEngine } from './engine.js';

const engine = createEngine(m => self.postMessage(m));
self.onmessage = e => engine.handle(e.data);
self.postMessage({ type: 'ready' });
