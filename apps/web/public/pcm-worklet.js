/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/*
 * AudioWorklet processor that batches microphone samples into 100 ms chunks for the
 * main thread (which downsamples them and sends them to the agent). It runs in the
 * audio thread, so it only copies; anything heavier would risk glitches on phones.
 * `sampleRate` is the AudioWorkletGlobalScope's: the context's real rate.
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.size - this.filled);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.size) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
