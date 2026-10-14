/**
 * Converts microphone audio from the browser's sample rate to the wire format the agent
 * plays into the virtual microphone (`AUDIO`: 16 kHz, mono, 16-bit). Each output sample
 * is the mean of the input samples it covers, which is a cheap low-pass that keeps
 * speech clean enough for dictation. The fractional remainder is carried to the next
 * call so chunks can be any length and odd ratios (44.1 kHz → 16 kHz) stay aligned.
 */
export function createDownsampler(
  fromRate: number,
  toRate: number,
): (input: Float32Array) => Int16Array {
  const ratio = fromRate / toRate;
  let carry = new Float32Array(0);
  return (input) => {
    let data = input;
    if (carry.length) {
      data = new Float32Array(carry.length + input.length);
      data.set(carry);
      data.set(input, carry.length);
    }
    const count = Math.floor(data.length / ratio);
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.min(data.length, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += data[j]!;
      out[i] = toInt16(sum / (end - start));
    }
    carry = data.slice(Math.floor(count * ratio));
    return out;
  };
}

function toInt16(v: number): number {
  if (v >= 1) return 32767;
  if (v <= -1) return -32768;
  return Math.round(v * 32767);
}
