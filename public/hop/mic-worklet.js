// AudioWorklet: collects microphone samples into 2048-sample chunks and posts them, with the
// AudioContext time of their first sample, straight to the decoder worker (via a transferred port).
class HopTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(2048);
    this.n = 0;
    this.out = null;
    this.port.onmessage = e => { if (e.data.port) this.out = e.data.port; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.out) return true;
    if (this.n === 0) this.t0 = (currentFrame) / sampleRate;
    this.chunk.set(ch, this.n);
    this.n += ch.length;
    if (this.n >= this.chunk.length) {
      const samples = this.chunk;
      this.out.postMessage({ type: 'audio', samples, ctxTime: this.t0 }, [samples.buffer]);
      this.chunk = new Float32Array(2048);
      this.n = 0;
    }
    return true;
  }
}
registerProcessor('hop-tap', HopTap);
